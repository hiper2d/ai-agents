import { AbstractAgent } from "./abstract-agent";
import OpenAI from "openai";
import { ModelError, ModelInvalidResponseError } from "../errors";
import { AIMessage, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG } from "../types";
import { calculateOpenAICost } from "../pricing";
import { stableHashHex } from "../text-utils";
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { toOpenAIEffort } from "../reasoning-effort";

export class Gpt5Agent extends AbstractAgent {
    private readonly client: OpenAI;
    // Routing hint for OpenAI's prefix cache (same scheme as the Mistral/Grok agents): one
    // key per agent+instruction, so an agent's own calls group together instead of every
    // agent that shares a static prefix hashing to the same route. Keys influence routing
    // only; they do not guarantee a hit.
    private readonly promptCacheKey: string;

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
        this.promptCacheKey = stableHashHex(`${name}\n${instruction}`);
        this.client = new OpenAI({
            apiKey: apiKey,
        });
    }


    /**
     * `reasoning: {effort}`, sent only when the catalog names a level. Every current OpenAI
     * model defaults to "medium" when the field is omitted — verified 2026-09-22 by calling
     * astra/sol/terra/luna with no reasoning param and reading the effort the API echoes back,
     * since OpenAI documents the default for Sol, Luna and the 5.6 family but not for Astra.
     * The catalog pins all four to medium so the level is explicit in our request rather than
     * inherited from a default OpenAI can change under us.
     */
    private reasoningParams(): Record<string, unknown> {
        return {
            reasoning: {
                ...(this.reasoningEffort ? { effort: toOpenAIEffort(this.reasoningEffort) } : {}),
                // Render reasoning from earlier turns into this sample. It is already the
                // default on all four models we run, but stated explicitly for the same reason
                // effort is. It only does anything because we replay the items ourselves.
                context: 'all_turns',
            },
        };
    }

    /**
     * Responses API input items, with each assistant turn's stored reasoning items replayed
     * immediately before it. OpenAI attaches `encrypted_content` to reasoning items whenever
     * `store` is false, which is how we call it: the documented stateless route is to preserve
     * the output items and replay the history yourself, rather than lean on
     * `previous_response_id` and OpenAI-side session state.
     *
     * This was a single flattened string before ("User: ... / Assistant: ..."), which left
     * nowhere to put reasoning items. The system prompt still travels ONLY as `instructions`.
     *
     * Reasoning is readable only within one model family and the API silently omits items it
     * cannot read, so a bot moved between GPT-6 and GPT-5.6 Terra loses its reasoning and keeps
     * working. A bot moved to another provider never reaches this code at all: every agent
     * reads only its own field, and a missing one falls back to a plain message.
     */
    private buildResponsesInput(messages: AIMessage[]): any[] {
        const input: any[] = [];
        for (const msg of this.prepareMessages(messages)) {
            if (msg.role === 'assistant' && msg.openaiEncryptedReasoning) {
                try {
                    const items = JSON.parse(msg.openaiEncryptedReasoning);
                    if (Array.isArray(items)) {
                        input.push(...items);
                    }
                } catch {
                    this.logger('Failed to parse stored encrypted reasoning, replaying message without it');
                }
            }
            input.push({ role: msg.role, content: msg.content });
        }
        return input;
    }

    /** The response's reasoning items, JSON-serialized for the caller to store on the message. */
    private extractReasoningItems(response: any): string | undefined {
        const items = (response?.output ?? []).filter(
            (item: any) => item?.type === 'reasoning' && item.encrypted_content
        );
        return items.length > 0 ? JSON.stringify(items) : undefined;
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

            // The system prompt travels ONLY as `instructions`. It used to be prepended to
            // `input` as well ("System: ..."), which billed every system token twice: on the
            // werewolf game's first-turn prompt, OpenAI bots measured ~5.1-5.5K input tokens
            // against ~3.2-3.5K for the same prompt on other providers (2026-09-06).
            const input = this.buildResponsesInput(messages);

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
                    prompt_cache_key: this.promptCacheKey,
                    // Stateless: encrypted reasoning is only returned for unstored responses.
                    store: false,
                    ...this.reasoningParams(),
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

            return [response.output_parsed, reasoningContent, tokenUsage, this.extractReasoningItems(response)];
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

            // The system prompt travels ONLY as `instructions`. It used to be prepended to
            // `input` as well ("System: ..."), which billed every system token twice: on the
            // werewolf game's first-turn prompt, OpenAI bots measured ~5.1-5.5K input tokens
            // against ~3.2-3.5K for the same prompt on other providers (2026-09-06).
            const input = this.buildResponsesInput(messages);

            const response = await this.client.responses.create({
                model: this.model,
                instructions: this.instruction,
                input: input,
                max_output_tokens: this.maxOutputTokens,
                prompt_cache_key: this.promptCacheKey,
                store: false,
                ...this.reasoningParams(),
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

            return [content, "", tokenUsage, this.extractReasoningItems(response)];
        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            if (error instanceof ModelError) {
                throw error;
            }
            throw new Error(this.errorMessages.apiError(error));
        }
    }

}