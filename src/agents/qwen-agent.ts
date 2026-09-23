import { AbstractAgent } from "./abstract-agent";
import { ModelError, ModelRefusalError } from "../errors";
import { stripInlineThinking } from "../thinking-utils";
import { OpenAI } from "openai";
import { AIMessage, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG } from "../types";
import { extractUsageAndCalculateCost } from "../pricing";
import { z } from 'zod';
import { ZodSchemaConverter } from '../zod-schema-converter';
import { parseAndValidateLlmJson } from '../json-response-parser';

// Qwen (QwenCloud/DashScope) agent. The API is OpenAI-compatible
// (https://dashscope-intl.aliyuncs.com/compatible-mode/v1), so we use the OpenAI SDK with a
// custom baseURL. Thinking is toggled with a top-level `enable_thinking` boolean and arrives in
// `message.reasoning_content` — verified live 2026-08-05 against qwen3.8-max / 3.7-plus /
// 3.7-flash, all of which accept non-streaming thinking requests.
//
// Structured output: Qwen's `response_format: json_object` is NOT supported in thinking mode,
// and we always think — so schema constraints are conveyed in-prompt and parsed leniently,
// never via response_format.

/**
 * Qwen's content filter answers HTTP 400 `InternalError.Algo.DataInspectionFailed: Input
 * text data may contain inappropriate content.` — the same class of verdict as Gemini's
 * PROHIBITED_CONTENT (a property of the prompt; the same prompt refuses again), so it
 * gets the same typed error. Observed in production 2026-09-13 on qwen-flash, in the game
 * that Gemini refused the same day.
 */
export function qwenRefusalFrom(model: string, apiError: unknown): ModelRefusalError | undefined {
    const message = apiError instanceof Error ? apiError.message : String(apiError);
    if (!/DataInspectionFailed|inappropriate content/i.test(message)) {
        return undefined;
    }
    const detail = message.replace(/^[\s\S]*DataInspectionFailed:\s*/, '').trim();
    return new ModelRefusalError(
        model,
        `${model} refused the prompt (refusalReason: DataInspectionFailed${detail ? `; ${detail}` : ''})`,
        'DataInspectionFailed'
    );
}

export class QwenAgent extends AbstractAgent {
    private readonly client: OpenAI;
    // A getter, not a field: `maxOutputTokens` can be raised after construction, and a field
    // initializer would snapshot the default and silently ignore the override.
    private get defaultParams(): Omit<Parameters<OpenAI['chat']['completions']['create']>[0], 'messages'> {
        return {
            model: this.model,
            temperature: this.temperature,
            stream: false,
            // Reasoning tokens share the completion budget on Qwen, so this has to leave room
            // for both CoT and answer — too small cuts the JSON mid-object.
            max_tokens: this.maxOutputTokens,
        };
    }

    private readonly logTemplates = {
        error: (name: string, error: unknown) => `Error in ${name} agent: ${error}`,
    };

    private readonly errorMessages = {
        emptyResponse: 'Empty or undefined response from Qwen API',
        invalidFormat: 'Invalid response format from Qwen API',
        apiError: (error: unknown) =>
            `Failed to get response from Qwen API: ${error instanceof Error ? error.message : String(error)}`,
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
            baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        });
    }

    /**
     * Thinking params for the request body. `thinking_budget` caps reasoning length and is only
     * sent when the instance has one (catalog default, or a per-call override like story
     * generation); without it the model thinks at the provider default, and qwen3.8-max's
     * latency then swings 30–100s.
     *
     * `reasoning_effort` is NOT sent, and the earlier reason recorded here was wrong. The
     * 2026-08-30 probe concluded "reasoning length doesn't track effort"; it had tested
     * low/high/max/xhigh, but Qwen only defines low|medium|xhigh and aliases both `high` and
     * `max` onto `xhigh`. So that probe compared low against xhigh twice and read the noise as
     * non-monotonicity.
     *
     * Re-probed 2026-09-22 with the documented levels, and effort tracks cleanly:
     *   qwen3.8-max     budget 1024 → 77 reasoning | low 132 | medium 160 | xhigh 422
     *   qwen3.8-flash   budget 1024 → 86 reasoning | low  87 | medium 251 | xhigh 417
     *
     * We still send the budget, for a better reason: the two are mutually exclusive (sending
     * both is a 400), Qwen documents effort as a coarse alias for a budget (low = 4,096,
     * medium = 16,384, xhigh = 262,144 tokens), and our 1,024 is tighter than the lowest level
     * it can express. The budget is the finer AND cheaper knob here, so `reasoningEffort` on
     * this agent stays ignored — deliberately, not because effort is broken.
     */
    private thinkingParams(): Record<string, unknown> {
        const budget = this.thinkingBudgetTokens;
        return {
            enable_thinking: this.enableThinking,
            ...(this.enableThinking && budget !== undefined ? { thinking_budget: budget } : {}),
            // Lets the model read the `reasoning_content` we replay on assistant messages, so a
            // bot keeps its own train of thought across turns. Qwen documents models as NOT
            // reading replayed reasoning unless this is set (qwen3.8-max and qwen3.8-flash are
            // both on the supported list). Measured 2026-09-22: qwen3.8-max actually used the
            // replayed reasoning with the flag off too, but we follow the documented contract
            // rather than rely on that. Stateless — the reasoning comes from our payload, not
            // from any server-side session.
            ...(this.enableThinking ? { preserve_thinking: true } : {}),
        };
    }

    /**
     * Assistant turns carry their own `reasoning_content` back so the model can reference what
     * it was thinking on earlier turns (paired with `preserve_thinking` in thinkingParams).
     * Qwen's reasoning is PLAIN TEXT, not a signed or encrypted blob, so there is nothing for
     * another provider to reject: a bot whose model changes mid-game simply stops sending it
     * and keeps working. The text is the same one the caller already stores as `thinking`.
     */
    private convertToOpenAIMessages(messages: AIMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return messages.map(msg => ({
            role: msg.role as 'system' | 'user' | 'assistant',
            content: msg.content,
            ...(msg.role === 'assistant' && msg.thinking ? { reasoning_content: msg.thinking } : {}),
        })) as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    }

    private extractThinkingAndUsage(
        completion: OpenAI.Chat.Completions.ChatCompletion
    ): { thinkingContent: string; tokenUsage?: TokenUsage } {
        let thinkingContent = "";
        const message = completion.choices[0]?.message as any;

        if (this.enableThinking && message?.reasoning_content) {
            thinkingContent = message.reasoning_content;
            this.logger(`Captured reasoning_content (${thinkingContent.length} characters)`);
        }

        let tokenUsage: TokenUsage | undefined;
        const usageResult = extractUsageAndCalculateCost(this.model, completion);

        if (usageResult) {
            tokenUsage = {
                inputTokens: usageResult.usage.promptTokens,
                outputTokens: usageResult.usage.completionTokens,
                totalTokens: usageResult.usage.totalTokens,
                costUSD: usageResult.cost,
                ...(usageResult.usage.cacheHitTokens !== undefined ? { cachedInputTokens: usageResult.usage.cacheHitTokens } : {})
            };

            if (this.enableThinking && usageResult.usage.reasoningTokens) {
                const reasoningTokens = usageResult.usage.reasoningTokens;
                const finalAnswerTokens = Math.max(0, tokenUsage.outputTokens - reasoningTokens);
                this.logger(
                    `Output breakdown: ${reasoningTokens} reasoning tokens, ${finalAnswerTokens} final answer tokens`
                );
            }
        }

        return { thinkingContent, tokenUsage };
    }

    /**
     * Robust schema-aware coercion of a model reply.
     * Order: strict JSON parse → embedded {…} extraction → wrap-as-reply (BotAnswer-shaped schemas).
     * Returns the validated value or throws.
     */
    private parseAndValidate<T>(rawReply: string, zodSchema: z.ZodSchema<T>): T {
        return parseAndValidateLlmJson(rawReply, zodSchema, (m) => this.logger(m));
    }

    async doAskWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        try {
            const preparedMessages = this.prepareMessages(messages);
            const openAIMessages = this.convertToOpenAIMessages(preparedMessages);

            // Add system instruction if needed
            if (openAIMessages.length > 0 && openAIMessages[0].role !== 'system') {
                openAIMessages.unshift({
                    role: 'system',
                    content: this.instruction
                });
            } else if (openAIMessages.length > 0 && openAIMessages[0].role === 'system') {
                openAIMessages[0].content = `${this.instruction}\n\n${openAIMessages[0].content}`;
            }

            this.logAsking(messages);
            this.logMessages(messages);

            // No response_format here on purpose: Qwen rejects JSON mode when thinking is
            // enabled, so the schema is enforced in-prompt + by the lenient parser.
            const schemaDescription = ZodSchemaConverter.toPromptDescription(zodSchema);
            const lastMessage = openAIMessages[openAIMessages.length - 1];
            if (lastMessage) {
                lastMessage.content += `\n\nIMPORTANT: Respond with ONLY a valid JSON object matching this schema. Do NOT write narration, roleplay actions, asterisks, or commentary outside the JSON. Output the JSON object and nothing else.\n${schemaDescription}`;
            }

            let completion;
            try {
                const params: any = {
                    ...this.defaultParams,
                    messages: openAIMessages,
                    ...this.thinkingParams()
                };
                completion = await this.client.chat.completions.create(params) as OpenAI.Chat.Completions.ChatCompletion;
            } catch (apiError) {
                this.logger(this.logTemplates.error(this.name, apiError));
                throw qwenRefusalFrom(this.model, apiError) ?? new Error(this.errorMessages.apiError(apiError));
            }

            const rawReply = completion.choices[0]?.message?.content;
            if (!rawReply) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const { text: reply, thinking: inlineThinking } = stripInlineThinking(rawReply);
            if (!reply) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const validated = this.parseAndValidate(reply, zodSchema);

            this.logger(`✅ Response validated successfully with Zod schema`);

            const { thinkingContent: reasoningContent, tokenUsage } = this.extractThinkingAndUsage(completion);
            const thinkingContent = [reasoningContent, inlineThinking].filter(Boolean).join("\n");

            if (validated) {
                this.logReply(validated, thinkingContent, tokenUsage);
            }

            return [validated, thinkingContent, tokenUsage];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            if (error instanceof ModelError) {
                throw error;
            }
            throw new Error(this.errorMessages.apiError(error));
        }
    }

    /**
     * Plain-text ask: no schema appended to the prompt.
     * Thinking toggle and reasoning_content extraction are identical to askWithZodSchema.
     */
    async doAskText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        try {
            const preparedMessages = this.prepareMessages(messages);
            const openAIMessages = this.convertToOpenAIMessages(preparedMessages);

            // Add system instruction if needed
            if (openAIMessages.length > 0 && openAIMessages[0].role !== 'system') {
                openAIMessages.unshift({
                    role: 'system',
                    content: this.instruction
                });
            } else if (openAIMessages.length > 0 && openAIMessages[0].role === 'system') {
                openAIMessages[0].content = `${this.instruction}\n\n${openAIMessages[0].content}`;
            }

            this.logAsking(messages);
            this.logMessages(messages);

            let completion;
            try {
                const params: any = {
                    ...this.defaultParams,
                    messages: openAIMessages,
                    ...this.thinkingParams()
                };
                completion = await this.client.chat.completions.create(params) as OpenAI.Chat.Completions.ChatCompletion;
            } catch (apiError) {
                this.logger(this.logTemplates.error(this.name, apiError));
                throw qwenRefusalFrom(this.model, apiError) ?? new Error(this.errorMessages.apiError(apiError));
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
            const thinkingContent = [reasoningContent, inlineThinking].filter(Boolean).join("\n");

            this.logReply(reply, thinkingContent, tokenUsage);

            return [reply, thinkingContent, tokenUsage];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            if (error instanceof ModelError) {
                throw error;
            }
            throw new Error(this.errorMessages.apiError(error));
        }
    }
}
