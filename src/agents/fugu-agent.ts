import { AbstractAgent } from "./abstract-agent";
import { toFuguEffort } from "../reasoning-effort";
import { mergeThinking, stripInlineThinking } from "../thinking-utils";
import { OpenAI } from "openai";
import { AIMessage, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG } from "../types";
import { calculateModelCost } from "../catalog";
import { z } from 'zod';
import { ZodSchemaConverter } from '../zod-schema-converter';
import { parseAndValidateLlmJson } from '../json-response-parser';

// Sakana Fugu agent. The API is OpenAI-compatible (https://api.sakana.ai/v1), so we use the
// OpenAI SDK with a custom baseURL. Every Fugu model always reasons; `reasoning_effort` takes
// high | xhigh | max (verified live 2026-09-20; anything else is a 400) and the SERVER DEFAULT
// DIFFERS PER MODEL — xhigh for fugu-ultra, high for fugu-max — so the field is always sent
// from the catalog pin (see the Fugu entries in catalog.ts for the measured latency and cost
// per level). Reasoning is never surfaced: responses carry reasoning_tokens but no
// reasoning_content (the field is still read in case that changes).
//
// Usage: fugu-ultra reports its internal expert calls as "orchestration" tokens in
// prompt_tokens_details / completion_tokens_details, OUTSIDE prompt_tokens / completion_tokens
// (total_tokens excludes them too), and bills them at the standard input/output rates
// (console.sakana.ai/pricing). They are 2-4x the visible counts, so they are folded into the
// reported usage here; the generic extractor would undercount Ultra by that much.
export class FuguAgent extends AbstractAgent {
    private readonly client: OpenAI;
    // A getter, not a field: `maxOutputTokens` can be raised after construction, and a field
    // initializer would snapshot the default and silently ignore the override.
    // `reasoning_effort` is re-declared as string: the OpenAI SDK's union lacks Sakana's 'max'.
    private get defaultParams(): Omit<Parameters<OpenAI['chat']['completions']['create']>[0], 'messages' | 'reasoning_effort'> & {
        reasoning_effort: string;
    } {
        return {
            model: this.model,
            stream: false,
            // Caps the final reply only. Per Sakana's docs the orchestrator "still uses maximum
            // token limit", so this bounds neither Ultra's latency nor its orchestration spend.
            max_tokens: this.maxOutputTokens,
            reasoning_effort: toFuguEffort(this.reasoningEffort ?? 'high'),
        };
    }

    private readonly logTemplates = {
        error: (name: string, error: unknown) => `Error in ${name} agent: ${error}`,
    };

    private readonly errorMessages = {
        emptyResponse: 'Empty or undefined response from Sakana Fugu API',
        invalidFormat: 'Invalid response format from Sakana Fugu API',
        apiError: (error: unknown) =>
            `Failed to get response from Sakana Fugu API: ${error instanceof Error ? error.message : String(error)}`,
    };

    constructor(
        name: string,
        instruction: string,
        model: string,
        apiKey: string,
        enableThinking: boolean = false,
        agentLoggingConfig: AgentLoggingConfig = DEFAULT_LOGGING_CONFIG.agents
    ) {
        // Fugu is a reasoning model and ignores temperature, so we pass a neutral default upstream.
        super(name, instruction, model, 1, enableThinking, agentLoggingConfig);
        this.client = new OpenAI({
            apiKey: apiKey,
            baseURL: 'https://api.sakana.ai/v1',
            timeout: 1200000,
        });
    }

    private convertToOpenAIMessages(messages: AIMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return messages.map(msg => ({
            role: msg.role as 'system' | 'user' | 'assistant',
            content: msg.content
        }));
    }

    private extractThinkingAndUsage(
        completion: OpenAI.Chat.Completions.ChatCompletion
    ): { thinkingContent: string; tokenUsage?: TokenUsage } {
        let thinkingContent = "";
        const message = completion.choices[0]?.message as any;

        if (message?.reasoning_content) {
            thinkingContent = message.reasoning_content;
            this.logger(`Captured reasoning_content (${thinkingContent.length} characters)`);
        }

        const tokenUsage = extractFuguTokenUsage(this.model, completion);
        if (tokenUsage) {
            const details: any = completion.usage ?? {};
            const orchestrationIn = details.prompt_tokens_details?.orchestration_input_tokens ?? 0;
            const orchestrationOut = details.completion_tokens_details?.orchestration_output_tokens ?? 0;
            if (tokenUsage.reasoningTokens || orchestrationIn || orchestrationOut) {
                this.logger(
                    `Usage breakdown: ${tokenUsage.reasoningTokens ?? 0} reasoning tokens; orchestration ${orchestrationIn} in / ${orchestrationOut} out (billed, folded into the totals)`
                );
            }
        }

        return { thinkingContent, tokenUsage };
    }

    private prependSystemInstruction(openAIMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
        if (openAIMessages.length > 0 && openAIMessages[0].role !== 'system') {
            openAIMessages.unshift({ role: 'system', content: this.instruction });
        } else if (openAIMessages.length > 0 && openAIMessages[0].role === 'system') {
            openAIMessages[0].content = `${this.instruction}\n\n${openAIMessages[0].content}`;
        }
    }

    async doAskWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        try {
            const preparedMessages = this.prepareMessages(messages);
            const openAIMessages = this.convertToOpenAIMessages(preparedMessages);
            this.prependSystemInstruction(openAIMessages);

            // Sakana's docs don't advertise structured output, but probing the live API shows it
            // accepts OpenAI's `json_object` mode (returns clean JSON; without it the model wraps
            // replies in ```json fences). We use json_object for a clean reply and still describe
            // the schema in-prompt for shape, parsing with the shared lenient parser. (Strict
            // `json_schema` mode also works but is avoided — like GlmAgent/GrokAgent — since the
            // game's optional/union Zod schemas don't satisfy strict-mode requirements.)
            const schemaDescription = ZodSchemaConverter.toPromptDescription(zodSchema);
            const lastMessage = openAIMessages[openAIMessages.length - 1];
            if (lastMessage) {
                lastMessage.content += `\n\nIMPORTANT: Respond with ONLY a valid JSON object matching this schema. Do NOT write narration, roleplay actions, asterisks, or commentary outside the JSON. Output the JSON object and nothing else.\n${schemaDescription}`;
            }

            this.logAsking(messages);
            this.logMessages(messages);

            let completion;
            try {
                const params: any = {
                    ...this.defaultParams,
                    messages: openAIMessages,
                    response_format: { type: 'json_object' },
                };
                completion = await this.client.chat.completions.create(params) as OpenAI.Chat.Completions.ChatCompletion;
            } catch (apiError) {
                this.logger(this.logTemplates.error(this.name, apiError));
                throw new Error(this.errorMessages.apiError(apiError));
            }

            const rawReply = completion.choices[0]?.message?.content;
            if (!rawReply) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const { text: reply, thinking: inlineThinking } = stripInlineThinking(rawReply);
            if (!reply) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const validated = parseAndValidateLlmJson(reply, zodSchema, (m) => this.logger(m));

            this.logger(`✅ Response validated successfully with Zod schema`);

            const { thinkingContent: reasoningContent, tokenUsage } = this.extractThinkingAndUsage(completion);
            const thinkingContent = mergeThinking(reasoningContent, inlineThinking);

            if (validated) {
                this.logReply(validated, thinkingContent, tokenUsage);
            }

            return [validated, thinkingContent, tokenUsage];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            throw new Error(this.errorMessages.apiError(error));
        }
    }

    /**
     * Plain-text ask: no schema appended to the prompt. Reasoning extraction and token
     * accounting are identical to askWithZodSchema.
     */
    async doAskText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        try {
            const preparedMessages = this.prepareMessages(messages);
            const openAIMessages = this.convertToOpenAIMessages(preparedMessages);
            this.prependSystemInstruction(openAIMessages);

            this.logAsking(messages);
            this.logMessages(messages);

            let completion;
            try {
                const params: any = {
                    ...this.defaultParams,
                    messages: openAIMessages,
                };
                completion = await this.client.chat.completions.create(params) as OpenAI.Chat.Completions.ChatCompletion;
            } catch (apiError) {
                this.logger(this.logTemplates.error(this.name, apiError));
                throw new Error(this.errorMessages.apiError(apiError));
            }

            const rawReply = completion.choices[0]?.message?.content;
            if (!rawReply) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const { text: reply, thinking: inlineThinking } = stripInlineThinking(rawReply);
            if (!reply) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const { thinkingContent: reasoningContent, tokenUsage } = this.extractThinkingAndUsage(completion);
            const thinkingContent = mergeThinking(reasoningContent, inlineThinking);

            this.logReply(reply, thinkingContent, tokenUsage);

            return [reply, thinkingContent, tokenUsage];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            throw new Error(this.errorMessages.apiError(error));
        }
    }
}

/**
 * Token usage for a Fugu chat completion with the orchestration tokens folded in. Exported for
 * the unit test; the agent calls it through extractThinkingAndUsage.
 *
 * Wire shape (fugu-ultra, observed 2026-09-20):
 *   usage.prompt_tokens / completion_tokens / total_tokens — the visible request only
 *   usage.prompt_tokens_details.{cached_tokens, orchestration_input_tokens, orchestration_input_cached_tokens}
 *   usage.completion_tokens_details.{reasoning_tokens, orchestration_output_tokens}
 * fugu-max reports the same fields with the orchestration counts at 0.
 */
export function extractFuguTokenUsage(modelApiName: string, completion: { usage?: any }): TokenUsage | undefined {
    const usage = completion?.usage;
    if (!usage) {
        return undefined;
    }
    const promptDetails = usage.prompt_tokens_details ?? {};
    const completionDetails = usage.completion_tokens_details ?? {};
    const inputTokens = (usage.prompt_tokens ?? 0) + (promptDetails.orchestration_input_tokens ?? 0);
    const outputTokens = (usage.completion_tokens ?? 0) + (completionDetails.orchestration_output_tokens ?? 0);
    const cachedInputTokens = (promptDetails.cached_tokens ?? 0) + (promptDetails.orchestration_input_cached_tokens ?? 0);
    const reasoningTokens = completionDetails.reasoning_tokens ?? 0;
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens,
        // Omitted rather than 0: consumers persist the object as-is (see TokenUsage).
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
        costUSD: calculateModelCost(modelApiName, inputTokens, outputTokens, {
            cacheHitTokens: cachedInputTokens,
            // Context-tier selection: the request's own size, not the orchestrator's traffic.
            contextTokens: usage.total_tokens ?? inputTokens,
        }),
    };
}
