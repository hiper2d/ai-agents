import { AbstractAgent } from "./abstract-agent";
import OpenAI from "openai";
import { ModelError, ModelInvalidResponseError } from "../errors";
import { AIMessage, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG } from "../types";
import { calculateOpenAICost } from "../pricing";
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

export class Gpt5Agent extends AbstractAgent {
    private readonly client: OpenAI;

    // Log message templates
    private readonly logTemplates = {
        error: (name: string, error: unknown) => `Error in ${name} agent: ${error}`,
    };

    // Error message templates
    private readonly errorMessages = {
        emptyResponse: 'Empty or undefined response from OpenAI API',
        invalidFormat: 'Invalid response format from OpenAI API',
        apiError: (error: unknown) =>
            `Failed to get response from OpenAI API: ${error instanceof Error ? error.message : String(error)}`,
    };


    constructor(
        name: string, 
        instruction: string, 
        model: string, 
        apiKey: string, 
        temperature: number, 
        enableThinking: boolean = false,
        agentLoggingConfig: AgentLoggingConfig = DEFAULT_LOGGING_CONFIG.agents
    ) {
        super(name, instruction, model, temperature, enableThinking, agentLoggingConfig);
        this.client = new OpenAI({
            apiKey: apiKey,
        });
    }


    /**
     * Structured output method using Zod with OpenAI's Responses API
     * This provides better schema handling and runtime validation
     * 
     * Uses responses.parse for models that support structured outputs
     */
    async doAskWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        try {
            this.logAsking(messages);
            this.logMessages(messages);

            // Combine system instruction with messages for the input
            const input = [
                `System: ${this.instruction}`,
                ...this.prepareMessages(messages).map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
            ].join('\n\n');

            // The caller's schema is sent as-is. A `thinking` field used to be appended here when
            // thinking was enabled, and it caused a serious failure mode (measured 2026-09-05):
            // OpenAI never exposes chain-of-thought, so the model had nothing to put in the field
            // and returned `"thinking":""` at best. Strict structured outputs emit keys in schema
            // order, so the injected field came LAST — and instead of committing to the empty
            // string, the model would drift into whitespace, which the JSON grammar permits
            // everywhere, until max_output_tokens cut the generation off one character short of a
            // closing brace. The response then failed JSON.parse and billed the full output cap.
            // A/B on gpt-6-astra, same casting prompt, 5 reps each: 3/5 runaways with the field,
            // 0/5 without. gpt-5.6-luna hit the identical failure once in a full pipeline run,
            // though its rate is far lower (0/5 on both arms of the same A/B), and gpt-5.6-sol /
            // gpt-5.6-terra were clean across 10 calls — the exposure scales with how eager a
            // model is to pad. Do not reintroduce the injection.
            const schemaToSend: z.ZodSchema<any> = zodSchema;

            let response;
            try {
                response = await this.client.responses.parse({
                    model: this.model,
                    instructions: this.instruction,
                    input: input,
                    max_output_tokens: this.maxOutputTokens,
                    text: {
                        format: zodTextFormat(schemaToSend, "response_schema"),
                    }
                });
            } catch (error) {
                // The SDK JSON.parses output_text inside responses.parse, so malformed JSON
                // (a generation truncated at max_output_tokens, or a runaway that never
                // closed the object) surfaces here as a bare SyntaxError.
                if (error instanceof SyntaxError) {
                    throw new ModelInvalidResponseError(
                        this.model,
                        `malformed JSON output — the generation was cut off at the ${this.maxOutputTokens}-token output cap or went off the rails (${error.message})`
                    );
                }
                throw error;
            }

            // A response can parse and still be incomplete (e.g. the whole budget went to
            // reasoning). Surface the cap hit explicitly rather than as a format error.
            if ((response as any).status === 'incomplete') {
                const reason = (response as any).incomplete_details?.reason ?? 'unknown';
                throw new ModelInvalidResponseError(
                    this.model,
                    `response incomplete (${reason}) at max_output_tokens=${this.maxOutputTokens}`,
                    reason === 'max_output_tokens'
                );
            }

            if (!response.output_parsed) {
                this.logger(`Parsing failed. Raw content: ${response.output_text}`);
                throw new ModelInvalidResponseError(this.model, this.errorMessages.invalidFormat);
            }

            // Reasoning content, only if the CALLER's own schema declares a thinking field — this
            // agent no longer adds one (see above), and OpenAI does not expose chain-of-thought,
            // so for most callers this stays empty.
            let reasoningContent = "";
            if (this.enableThinking && (response.output_parsed as any).thinking) {
                reasoningContent = (response.output_parsed as any).thinking;
            }

            // Extract token usage
            let tokenUsage: TokenUsage | undefined;
            if (response.usage) {
                // Responses API reports cache hits under input_tokens_details.cached_tokens
                // (input_tokens already INCLUDES them); bill hits at the cached rate.
                const cachedTokens = (response.usage as any).input_tokens_details?.cached_tokens ?? 0;
                const cost = calculateOpenAICost(
                    this.model,
                    response.usage.input_tokens,
                    response.usage.output_tokens,
                    cachedTokens
                );
                if (cachedTokens > 0) {
                    this.logger(`💾 Prompt cache: ${cachedTokens} of ${response.usage.input_tokens} input tokens served from cache`);
                }

                tokenUsage = {
                    inputTokens: response.usage.input_tokens,
                    outputTokens: response.usage.output_tokens,
                    totalTokens: response.usage.total_tokens || 0,
                    costUSD: cost,
                    ...(response.usage.output_tokens_details?.reasoning_tokens ? { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens } : {}),
                    ...(response.usage.input_tokens_details?.cached_tokens ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens } : {})
                };

                // Log reasoning token breakdown if available
                if (response.usage.output_tokens_details?.reasoning_tokens) {
                    const reasoningTokens = response.usage.output_tokens_details.reasoning_tokens;
                    const finalAnswerTokens = tokenUsage.outputTokens - reasoningTokens;
                    this.logger(`Output breakdown: ${reasoningTokens} reasoning tokens, ${finalAnswerTokens} final answer tokens`);
                }
            }

            if (response.output_parsed) {
                this.logReply(response.output_parsed, reasoningContent, tokenUsage);
            }

            this.logger(`✅ Response validated successfully with Zod schema`);

            return [response.output_parsed, reasoningContent, tokenUsage];
        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            if (error instanceof ModelError) {
                throw error;
            }
            throw new Error(this.errorMessages.apiError(error));
        }
    }

    /**
     * Plain-text ask via the Responses API: no structured-output format, raw output_text.
     * Note: askWithZodSchema surfaces "thinking" via a schema-injected field; that trick
     * doesn't apply to plain text, so thinking content is empty here (OpenAI does not
     * expose chain-of-thought directly).
     */
    async doAskText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        try {
            this.logAsking(messages);
            this.logMessages(messages);

            // Combine system instruction with messages for the input
            const input = [
                `System: ${this.instruction}`,
                ...this.prepareMessages(messages).map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
            ].join('\n\n');

            const response = await this.client.responses.create({
                model: this.model,
                instructions: this.instruction,
                input: input,
                max_output_tokens: this.maxOutputTokens,
            });

            const content = response.output_text;
            if (!content) {
                // An incomplete response with no visible text usually means the whole
                // output budget went to reasoning before any answer tokens were emitted.
                if ((response as any).status === 'incomplete') {
                    const reason = (response as any).incomplete_details?.reason ?? 'unknown';
                    throw new ModelInvalidResponseError(
                        this.model,
                        `empty response, incomplete (${reason}) at max_output_tokens=${this.maxOutputTokens}`,
                        reason === 'max_output_tokens'
                    );
                }
                throw new Error(this.errorMessages.emptyResponse);
            }

            // Extract token usage
            let tokenUsage: TokenUsage | undefined;
            if (response.usage) {
                // Responses API reports cache hits under input_tokens_details.cached_tokens
                // (input_tokens already INCLUDES them); bill hits at the cached rate.
                const cachedTokens = (response.usage as any).input_tokens_details?.cached_tokens ?? 0;
                const cost = calculateOpenAICost(
                    this.model,
                    response.usage.input_tokens,
                    response.usage.output_tokens,
                    cachedTokens
                );
                if (cachedTokens > 0) {
                    this.logger(`💾 Prompt cache: ${cachedTokens} of ${response.usage.input_tokens} input tokens served from cache`);
                }

                tokenUsage = {
                    inputTokens: response.usage.input_tokens,
                    outputTokens: response.usage.output_tokens,
                    totalTokens: response.usage.total_tokens || 0,
                    costUSD: cost,
                    ...(response.usage.output_tokens_details?.reasoning_tokens ? { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens } : {}),
                    ...(response.usage.input_tokens_details?.cached_tokens ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens } : {})
                };

                if (response.usage.output_tokens_details?.reasoning_tokens) {
                    const reasoningTokens = response.usage.output_tokens_details.reasoning_tokens;
                    const finalAnswerTokens = tokenUsage.outputTokens - reasoningTokens;
                    this.logger(`Output breakdown: ${reasoningTokens} reasoning tokens, ${finalAnswerTokens} final answer tokens`);
                }
            }

            this.logReply(content, "", tokenUsage);

            return [content, "", tokenUsage];
        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            if (error instanceof ModelError) {
                throw error;
            }
            throw new Error(this.errorMessages.apiError(error));
        }
    }

}