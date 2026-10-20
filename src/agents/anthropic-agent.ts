import { ModelError, ModelRefusalError } from "../errors";
import { toAnthropicEffort } from "../reasoning-effort";
import { AbstractAgent } from "./abstract-agent";
import { AIMessage, BotResponseError, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG } from "../types";
import { Anthropic } from '@anthropic-ai/sdk';
import { calculateAnthropicCost } from "../pricing";
import { z } from 'zod';
import { ZodSchemaConverter } from '../zod-schema-converter';
import { parseAndValidateLlmJson } from '../json-response-parser';

type AnthropicRole = 'user' | 'assistant';

// Content block types for thinking-enabled messages
interface ThinkingBlock {
    type: 'thinking';
    thinking: string;
    signature?: string;  // Required for Claude 4+ multi-turn conversations
}

type CacheTtl = '5m' | '1h';

/**
 * Models that reject `thinking: {type: "disabled"}` with a 400 and can only run adaptive.
 * Fable has no non-thinking variant at all; Opus 5.5 (2026-09-22) dropped the disabled mode
 * that Opus 5 still accepted at effort <= high, answering with
 *   "thinking.type.disabled" is not supported for this model.
 * For these, omit `thinking` entirely — the API then runs adaptive at the model's default
 * effort, which is the only legal way to ask them for a cheap, shallow answer.
 */
const rejectsDisabledThinking = (model: string): boolean =>
    model.includes('fable') || model.includes('opus-5-5');

/**
 * Sonnet 5.5 (2026-09-28) also rejects `disabled`, but unlike Fable and Opus 5.5 it has a real
 * off switch: `thinking: {type: "between_tools"}` turns off up-front thinking (only progress
 * notes between tool calls remain, and we send no tools). It takes no other field and is legal
 * only at effort <= high, so it goes out without `output_config`.
 */
const usesBetweenToolsForOff = (model: string): boolean => model.includes('sonnet-5-5');

/**
 * Every current Claude model thinks adaptively, steered by `output_config.effort`, and rejects
 * a non-default temperature. Only Haiku 4.5 predates that: it takes `enabled` thinking with
 * `budget_tokens`. Haiku 5.5 (2026-10-07) moved to adaptive and answers `enabled` with
 *   "thinking.type.enabled" is not supported for this model.
 * Unlike Sonnet 5.5 it still accepts `disabled` (and rejects `between_tools`).
 */
const usesAdaptiveThinking = (model: string): boolean => !model.includes('haiku-4');

interface TextBlock {
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral'; ttl?: CacheTtl };
}

type ContentBlock = ThinkingBlock | TextBlock;

interface AnthropicMessage {
    role: AnthropicRole;
    content: string | ContentBlock[];
}

export class ClaudeAgent extends AbstractAgent {
    private readonly client: Anthropic;
    /**
     * TTL for every breakpoint this agent places (system tiers and the message anchor).
     * Anthropic bills a 5m write at 1.25x input, a 1h write at 2x, reads at 0.1x, and a read
     * refreshes the timer on either TTL. Default '1h' because the main consumer runs at human
     * pace: consecutive calls for one agent measured 12-78 minutes apart, so 5m entries
     * expired before they were ever read (0-16% hit rate over 30 days, hits only on gaps
     * under five minutes). Set '5m' for continuous traffic where every call lands inside the
     * window; there the cheaper write wins. One knob for all breakpoints on purpose: Anthropic
     * requires 1h entries to precede 5m ones, and a single TTL keeps that trivially true.
     */
    cacheTtl: CacheTtl = '1h';
    // System-prompt breakpoints, one per cache tier (see CACHE_TIER_MARKER):
    //   block 1 - shared static rules, byte-identical across all bots and games with the
    //             same rule set. Caches are scoped per model, so one entry serves every bot
    //             ON THAT MODEL (not the whole lobby), and any of their calls refreshes it;
    //   block 2 - per-bot identity + game state + summaries, byte-stable between the game's
    //             state writes (a lynch, the night resolution, the summary rewrite, the new
    //             day), so every call inside one of those windows reads it.
    // GM prompts have no marker → single block, same behavior as before. Haiku 4.5 needs a
    // 4096-token cacheable prefix, so tiers below that silently no-op there; Haiku 5.5 caches
    // from ~1024 tokens (measured 2026-10-08: a 1,083-token prefix was written, 492 was not).
    // A getter, not a field: `maxOutputTokens` can be raised after construction, and a field
    // initializer would snapshot the default and silently ignore the override.
    private get defaultParams(): Omit<Anthropic.MessageCreateParams, 'messages'> {
        return {
            max_tokens: this.maxOutputTokens,
            system: this.instructionParts.map(part => (
                { type: 'text' as const, text: part, cache_control: { type: 'ephemeral' as const, ttl: this.cacheTtl } }
            )),
            model: this.model,
        };
    }

    // Log message templates
    private readonly logTemplates = {
        error: (name: string, error: unknown) => `Error in ${name} agent: ${error}`,
    };

    // Error message templates
    private readonly errorMessages = {
        emptyResponse: 'Empty response from Anthropic API',
        invalidFormat: 'Invalid response format from Anthropic API',
        apiError: (error: unknown) =>
            `Failed to get response from Anthropic API: ${error instanceof Error ? error.message : String(error)}`,
        unsupportedRole: (role: string) => `Unsupported role type: ${role}`,
    };


    constructor(
        name: string, 
        instruction: string, 
        model: string, 
        apiKey: string, 
        enableThinking: boolean = false,
        agentLoggingConfig: AgentLoggingConfig = DEFAULT_LOGGING_CONFIG.agents
    ) {
        super(name, instruction, model, 0.2, enableThinking, agentLoggingConfig);
        this.client = new Anthropic({
            apiKey: apiKey,
        });
    }



    /**
     * Unlike the base class, does NOT merge consecutive user messages: the Messages API
     * combines consecutive user turns into a single turn while preserving separate content
     * blocks, so the trailing reminder stays out of the persisted command block and the
     * fast cache breakpoint (see applyCacheBreakpoint) lands on bytes that repeat.
     */
    protected prepareMessages(messages: AIMessage[]): AIMessage[] {
        return messages;
    }

    private convertToAnthropicMessages(messages: AIMessage[]): AnthropicMessage[] {
        return messages.map(msg => ({
            role: this.convertRole(msg.role),
            content: msg.content
        }));
    }

    /**
     * Converts messages for thinking-enabled requests.
     * Assistant messages include thinking blocks ONLY if they have valid signatures.
     * If a signature is missing, the thinking block is dropped to ensure API validity.
     */
    private convertToAnthropicMessagesWithThinking(messages: AIMessage[]): AnthropicMessage[] {
        // Track thinking stats for aggregated logging
        let assistantMsgCount = 0;
        let withThinking = 0;
        let withValidAnthropicSig = 0;
        let droppedGoogleSig = 0;
        let droppedNoSig = 0;

        const result = messages.map(msg => {
            const role = this.convertRole(msg.role);

            if (role === 'assistant') {
                assistantMsgCount++;

                if (msg.thinking && msg.anthropicThinkingSignature) {
                    withThinking++;
                    withValidAnthropicSig++;
                    const thinkingBlock: ThinkingBlock = {
                        type: 'thinking',
                        thinking: msg.thinking,
                        signature: msg.anthropicThinkingSignature
                    };
                    const contentBlocks: ContentBlock[] = [
                        thinkingBlock,
                        { type: 'text', text: msg.content }
                    ];
                    return { role, content: contentBlocks };
                }

                // Track dropped thinking
                if (msg.thinking) {
                    withThinking++;
                    if (msg.googleThoughtSignature) {
                        droppedGoogleSig++;
                    } else {
                        droppedNoSig++;
                    }
                }

                // Fallback for text-only messages or messages with missing signatures
                return { role, content: msg.content };
            }

            // User messages remain as simple strings
            return { role, content: msg.content };
        });

        // Log aggregated thinking stats once
        if (withThinking > 0) {
            const dropped = droppedGoogleSig + droppedNoSig;
            let dropReason = '';
            if (droppedGoogleSig > 0) dropReason += `${droppedGoogleSig} with Google signature`;
            if (droppedNoSig > 0) dropReason += `${droppedNoSig > 0 && droppedGoogleSig > 0 ? ', ' : ''}${droppedNoSig} without signature`;

            this.logger(`📊 Thinking history: ${assistantMsgCount} assistant msgs, ${withThinking} with thinking, ` +
                `${withValidAnthropicSig} included, ${dropped} dropped${dropped > 0 ? ` (${dropReason})` : ''}`);
        }

        return result;
    }

    /**
     * Breakpoint 2 (fast tier): the last message that will be re-sent byte-identically on
     * the next request. That is the SECOND-to-last message, not the last one — the final
     * user message carries unpersisted content (the reminder postfix / schema description)
     * appended to the GM command, so its bytes never repeat and a breakpoint there would be
     * a pure 1.25x write tax with no reads. The second-to-last message (the bot's previous
     * reply, or an earlier flushed block) reappears verbatim next turn, where the moved-
     * forward breakpoint finds it via the 20-block lookback.
     *
     * NOT the top-level auto-caching mode: that mode targets the LAST cacheable block,
     * which for us is exactly the never-repeated tail — every entry it wrote would be dead.
     */
    private applyCacheBreakpoint(messages: AnthropicMessage[]): void {
        if (messages.length < 2) {
            return; // one-shot call: system-prompt breakpoint still applies
        }
        const anchor = messages[messages.length - 2];
        if (typeof anchor.content === 'string') {
            if (anchor.content.length > 0) {
                anchor.content = [{ type: 'text', text: anchor.content, cache_control: { type: 'ephemeral', ttl: this.cacheTtl } }];
            }
            return;
        }
        // Thinking blocks are not cacheable — mark the last text block instead.
        for (let i = anchor.content.length - 1; i >= 0; i--) {
            const block = anchor.content[i];
            if (block.type === 'text' && block.text.length > 0) {
                block.cache_control = { type: 'ephemeral', ttl: this.cacheTtl };
                return;
            }
        }
    }

    /**
     * Builds TokenUsage from the response. Anthropic's input_tokens EXCLUDES cached tokens
     * (total prompt = input_tokens + cache_read + cache_creation), unlike the OpenAI-shaped
     * providers whose prompt_tokens include them — so reconstruct the full prompt size here
     * before pricing. Cache reads bill at the cacheHitPrice (~0.1x); cache writes bill at
     * 1.25x input, which MODEL_PRICING doesn't model, so written tokens are priced at the
     * plain input rate (~20% undercount on the written span only).
     */
    private buildTokenUsage(usage: Anthropic.Messages.Usage): TokenUsage {
        const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
        const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
        const uncachedInputTokens = usage.input_tokens || 0;
        const inputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
        const outputTokens = usage.output_tokens || 0;
        const cost = calculateAnthropicCost(this.model, inputTokens, outputTokens, cacheReadTokens);

        if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
            this.logger(`💾 Prompt cache: ${cacheReadTokens} read, ${cacheWriteTokens} written, ${uncachedInputTokens} uncached`);
        }

        return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUSD: cost,
            // Cache reads only — writes are a billing premium, not reuse of prior context.
            ...(cacheReadTokens > 0 ? { cachedInputTokens: cacheReadTokens } : {})
        };
    }

    private convertRole(role: string): AnthropicRole {
        if (role === 'system' || role === 'user') {
            return 'user';
        }
        if (role === 'assistant') {
            return 'assistant';
        }
        throw new Error(this.errorMessages.unsupportedRole(role));
    }

    /**
     * Schema-validated ask on Anthropic structured outputs: the Zod schema goes out as JSON
     * Schema in `output_config.format`, so the API constrains the reply to that shape and the
     * model cannot answer in another one. Until 0.25.0 the schema was only described in prose
     * appended to the last message and the reply parsed as text; Sonnet 5.5 once answered a
     * vote with a tool-call shaped `<invoke name="json">` block instead (2026-10-18). The
     * field descriptions travel inside the schema, so nothing is appended to the prompt any
     * more. The reply is still run through the shared lenient parser + Zod on our side: same
     * error messages for the host's retry hints, and a guard for a null-formatted reply.
     */
    async doAskWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        // Validate roles first, before entering the main try-catch block
        const aiMessages = this.prepareMessages(messages);

        this.logAsking(messages);
        this.logMessages(messages);

        try {
            // Use thinking if enabled for this agent
            const canUseThinking = this.enableThinking;

            // Convert messages - use thinking-aware conversion when thinking can be used
            const anthropicMessages = canUseThinking
                ? this.convertToAnthropicMessagesWithThinking(aiMessages)
                : this.convertToAnthropicMessages(aiMessages);
            this.applyCacheBreakpoint(anthropicMessages);

            const params: Anthropic.MessageCreateParams = {
                ...this.defaultParams,
                messages: anthropicMessages as Anthropic.MessageParam[],
            };

            // Add thinking config for Anthropic models with thinking mode.
            // Adaptive models reject the temperature param (and budget_tokens) — only Haiku 4.5
            // still uses enabled thinking with a budget (see usesAdaptiveThinking).
            // Fable's thinking is always on: it has no non-thinking variant and rejects
            // thinking:{type:"disabled"}, so it only ever hits the adaptive branch below.
            const adaptive = usesAdaptiveThinking(this.model);
            if (canUseThinking) {
                if (adaptive) {
                    // Adaptive thinking with effort control.
                    // display: "summarized" is required to surface the reasoning — these models
                    // default to "omitted", which returns thinking blocks with an empty field.
                    (params as any).thinking = { type: "adaptive", display: "summarized" };
                    (params as any).output_config = { effort: toAnthropicEffort(this.reasoningEffort ?? "high") };
                } else {
                    // Haiku 4.5 uses enabled thinking with budget
                    (params as any).thinking = { type: "enabled", budget_tokens: this.thinkingBudgetTokens ?? 1024 };
                    params.temperature = 1;
                }
            } else if (adaptive) {
                // Opus 4.8 / Sonnet 5 reject a non-default temperature. Sonnet 5 also defaults to
                // adaptive thinking when `thinking` is omitted, so disable it explicitly to keep the
                // non-thinking variant from reasoning (avoiding extra thinking cost and latency).
                // Fable and Opus 5.5 refuse the disabled mode outright — leave `thinking` unset.
                // Sonnet 5.5 refuses it too, but turns thinking off with `between_tools`.
                if (usesBetweenToolsForOff(this.model)) {
                    (params as any).thinking = { type: "between_tools" };
                } else if (!rejectsDisabledThinking(this.model)) {
                    (params as any).thinking = { type: "disabled" };
                }
            } else {
                // Older models (Haiku 4.5): no adaptive thinking; pass the configured temperature.
                params.temperature = this.temperature;
            }

            // Structured output: merged into output_config next to `effort` (set above for
            // adaptive thinking), never replacing it. Each distinct schema is compiled once by
            // Anthropic and cached for 24h, so the handful of fixed game schemas cost one slow
            // first call each.
            params.output_config = {
                ...(params.output_config ?? {}),
                format: { type: 'json_schema', schema: ZodSchemaConverter.toAnthropicSchema(zodSchema) },
            };

            let response;
            try {
                response = await this.client.messages.create(params);
            } catch (apiError) {
                // Re-throw API errors immediately without wrapping them in schema validation errors
                this.logger(this.logTemplates.error(this.name, apiError));
                throw new Error(this.errorMessages.apiError(apiError));
            }

            if ((response as any).stop_reason === 'refusal') {
                throw new ModelRefusalError(this.model, undefined, 'refusal');
            }
            if (!('content' in response) || !Array.isArray(response.content) || response.content.length === 0) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            // Handle thinking content if present and find text content
            let textContent = null;
            let thinkingContent = "";
            let anthropicThinkingSignature = "";

            for (const block of response.content) {
                // Extract thinking content and signature
                if (this.enableThinking && (block as any).type === 'thinking' && 'thinking' in block) {
                    thinkingContent = (block as any).thinking;
                    // Extract signature if present (required for Claude 4+ multi-turn)
                    if ('signature' in block) {
                        anthropicThinkingSignature = (block as any).signature;
                    }
                }

                // Find the text content block
                if ('text' in block && !textContent) {
                    textContent = block.text;
                }
            }

            if (!textContent) {
                throw new Error(this.errorMessages.invalidFormat);
            }

            // The text block is the schema-shaped JSON. Validate it on our side anyway: same
            // lenient parser and error wording as every other agent, so a host's retry hints
            // keep matching, and a defence for a reply the format did not constrain (e.g. a
            // max_tokens cut mid-object).
            const parsedData = parseAndValidateLlmJson(textContent, zodSchema, (m) => this.logger(m));

            this.logger(`✅ Response validated successfully with Zod schema`);

            // Extract token usage information
            let tokenUsage: TokenUsage | undefined;
            if (response.usage) {
                tokenUsage = this.buildTokenUsage(response.usage);

                // Log thinking information if available
                if (this.enableThinking && thinkingContent) {
                    this.logger(`Thinking enabled: ${thinkingContent.length} characters of thinking content`);
                    this.logger(`Note: Thinking tokens are included in output token count and cost`);
                }
            }

            if (parsedData) {
                this.logReply(parsedData, thinkingContent || undefined, tokenUsage);
            }

            return [parsedData, thinkingContent, tokenUsage, anthropicThinkingSignature || undefined];

        } catch (error) {
            // Typed model errors carry their own meaning (a refusal is not retryable and not
            // an API failure) — let them through untouched, as GoogleAgent does with its
            // ModelError family.
            if (error instanceof ModelError) {
                throw error;
            }
            const errorDetails = error instanceof Error ? error.message : String(error);

            // Check if this is an API overload error (529) which is recoverable
            const isRecoverable = errorDetails.includes('overloaded_error') ||
                errorDetails.includes('529') ||
                errorDetails.includes('rate_limit');

            throw new BotResponseError(
                'Failed to get response from Anthropic API with Zod schema',
                errorDetails,
                {
                    model: this.model,
                    agentName: this.name,
                    apiProvider: 'Anthropic',
                    schemaType: 'zod'
                },
                isRecoverable
            );
        }
    }

    /**
     * Plain-text ask: same request as askWithZodSchema but without a schema description
     * appended to the prompt and without JSON parsing. Thinking blocks and signatures
     * are extracted identically.
     */
    async doAskText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        const aiMessages = this.prepareMessages(messages);

        this.logAsking(messages);
        this.logMessages(messages);

        try {
            const canUseThinking = this.enableThinking;

            const anthropicMessages = canUseThinking
                ? this.convertToAnthropicMessagesWithThinking(aiMessages)
                : this.convertToAnthropicMessages(aiMessages);
            this.applyCacheBreakpoint(anthropicMessages);

            const params: Anthropic.MessageCreateParams = {
                ...this.defaultParams,
                messages: anthropicMessages as Anthropic.MessageParam[],
            };

            // Add thinking config for Anthropic models with thinking mode.
            // Adaptive models have deprecated the temperature param (and budget_tokens). Fable's
            // thinking is always on: it rejects thinking:{type:"disabled"}, so it only ever hits
            // the adaptive branch below.
            const adaptive = usesAdaptiveThinking(this.model);
            if (canUseThinking) {
                if (adaptive) {
                    (params as any).thinking = { type: "adaptive", display: "summarized" };
                    (params as any).output_config = { effort: toAnthropicEffort(this.reasoningEffort ?? "high") };
                } else {
                    (params as any).thinking = { type: "enabled", budget_tokens: this.thinkingBudgetTokens ?? 1024 };
                    params.temperature = 1;
                }
            } else if (adaptive) {
                // Opus 4.8 / Sonnet 5 reject a non-default temperature and default to adaptive
                // thinking when `thinking` is omitted; disable it explicitly for the non-thinking variant.
                // Fable and Opus 5.5 refuse the disabled mode outright — leave `thinking` unset.
                // Sonnet 5.5 refuses it too, but turns thinking off with `between_tools`.
                if (usesBetweenToolsForOff(this.model)) {
                    (params as any).thinking = { type: "between_tools" };
                } else if (!rejectsDisabledThinking(this.model)) {
                    (params as any).thinking = { type: "disabled" };
                }
            } else {
                // Older models (Haiku 4.5): no adaptive thinking; pass the configured temperature.
                params.temperature = this.temperature;
            }

            let response;
            try {
                response = await this.client.messages.create(params);
            } catch (apiError) {
                this.logger(this.logTemplates.error(this.name, apiError));
                throw new Error(this.errorMessages.apiError(apiError));
            }

            if ((response as any).stop_reason === 'refusal') {
                throw new ModelRefusalError(this.model, undefined, 'refusal');
            }
            if (!('content' in response) || !Array.isArray(response.content) || response.content.length === 0) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            // Extract thinking and concatenate all text blocks
            const textParts: string[] = [];
            let thinkingContent = "";
            let anthropicThinkingSignature = "";

            for (const block of response.content) {
                if (this.enableThinking && (block as any).type === 'thinking' && 'thinking' in block) {
                    thinkingContent = (block as any).thinking;
                    if ('signature' in block) {
                        anthropicThinkingSignature = (block as any).signature;
                    }
                }

                if ('text' in block) {
                    textParts.push(block.text);
                }
            }

            const textContent = textParts.join('');
            if (!textContent) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            let tokenUsage: TokenUsage | undefined;
            if (response.usage) {
                tokenUsage = this.buildTokenUsage(response.usage);

                if (this.enableThinking && thinkingContent) {
                    this.logger(`Thinking enabled: ${thinkingContent.length} characters of thinking content`);
                    this.logger(`Note: Thinking tokens are included in output token count and cost`);
                }
            }

            this.logReply(textContent, thinkingContent || undefined, tokenUsage);

            return [textContent, thinkingContent, tokenUsage, anthropicThinkingSignature || undefined];

        } catch (error) {
            // Typed model errors carry their own meaning (a refusal is not retryable and not
            // an API failure) — let them through untouched, as GoogleAgent does with its
            // ModelError family.
            if (error instanceof ModelError) {
                throw error;
            }
            const errorDetails = error instanceof Error ? error.message : String(error);

            const isRecoverable = errorDetails.includes('overloaded_error') ||
                errorDetails.includes('529') ||
                errorDetails.includes('rate_limit');

            throw new BotResponseError(
                'Failed to get response from Anthropic API',
                errorDetails,
                {
                    model: this.model,
                    agentName: this.name,
                    apiProvider: 'Anthropic',
                    schemaType: 'text'
                },
                isRecoverable
            );
        }
    }
}
