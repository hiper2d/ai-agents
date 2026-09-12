import {AbstractAgent} from "./abstract-agent";
import { stableHashHex } from "../text-utils";
import {OpenAI} from "openai";
import {AIMessage, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG} from "../types";
import {parseAndValidateLlmJson} from '../json-response-parser';
import {calculateMetaCost} from "../pricing";
import {toMetaEffort} from "../reasoning-effort";
import {z} from 'zod';
import {ZodSchemaConverter} from '../zod-schema-converter';

/**
 * Meta Model API agent (Muse Spark) on the Responses API at api.meta.ai.
 *
 * Muse Spark is an always-on reasoning model: `reasoning.effort` picks the depth
 * (minimal … max; "none" is rejected with a 400) and the catalog pins a default per entry.
 * The chain of thought itself is never returned; a summary is requested with
 * `reasoning.summary: "auto"` and surfaces as the thinking string. Each response's encrypted
 * reasoning items (requested via `include: ["reasoning.encrypted_content"]`) come back as the
 * 4th tuple element, are stored on the message as `metaEncryptedReasoning`, and are replayed
 * into `input` on later turns so the model keeps its reasoning across the conversation —
 * the same contract as the Grok agent.
 *
 * Prompt caching is automatic on Meta's side; `prompt_cache_key` only routes requests that
 * share a prefix to the same backend, so it is derived from the bot's identity + system
 * prompt (stable within a game day, like Grok's conversation id).
 *
 * Structured output uses the documented `text.format` json_schema mode (strict: false —
 * Meta's strict subset forbids optional keys and unions that game schemas use), with the
 * schema description also appended to the prompt and the lenient parser on the way back.
 */
export class MetaAgent extends AbstractAgent {
    private readonly client: OpenAI;
    private readonly promptCacheKey: string;

    // Log message templates
    private readonly logTemplates = {
        error: (name: string, error: unknown) => `Error in ${name} agent: ${error}`,
    };

    // Error message templates
    private readonly errorMessages = {
        emptyResponse: 'Empty or undefined response from Meta API',
        invalidFormat: 'Invalid response format from Meta API',
        apiError: (error: unknown) =>
            `Failed to get response from Meta API: ${error instanceof Error ? error.message : String(error)}`,
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
            baseURL: 'https://api.meta.ai/v1',
            timeout: 1200000,
        });
    }

    /**
     * Structured output: json_schema format on the Responses API plus the schema described
     * in the prompt, parsed leniently and validated with Zod.
     */
    async doAskWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        try {
            const schemaDescription = ZodSchemaConverter.toPromptDescription(zodSchema);
            const input = this.buildResponsesInput(this.prepareMessages(messages));

            // Add schema description to the last message to ensure the model follows it
            const lastMessage = input[input.length - 1];
            if (lastMessage && typeof lastMessage.content === 'string') {
                lastMessage.content += `\n\nYour response must be a valid JSON object matching this schema:\n${schemaDescription}`;
            }

            this.logAsking(messages);
            this.logMessages(messages);

            const response = await this.createResponse(input, zodSchema);
            const { text, reasoningSummary, encryptedReasoning } = this.extractResponseParts(response);
            if (!text) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            this.logger(`Meta Agent - Found reasoning summary: ${!!reasoningSummary}, encrypted reasoning: ${!!encryptedReasoning}`);

            // Parse and validate the response using the shared lenient parser
            const parsedData = parseAndValidateLlmJson(text, zodSchema, (m) => this.logger(m));

            this.logger(`✅ Response validated successfully with Zod schema`);

            const tokenUsage = this.extractTokenUsage(response);

            if (parsedData) {
                this.logReply(parsedData, reasoningSummary, tokenUsage);
            }

            return [parsedData, reasoningSummary, tokenUsage, encryptedReasoning];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            throw new Error(this.errorMessages.apiError(error));
        }
    }

    /**
     * Plain-text ask: no JSON mode and no schema appended to the prompt.
     * Reasoning extraction and token accounting are identical to askWithZodSchema.
     */
    async doAskText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        try {
            const input = this.buildResponsesInput(this.prepareMessages(messages));

            this.logAsking(messages);
            this.logMessages(messages);

            const response = await this.createResponse(input);
            const { text, reasoningSummary, encryptedReasoning } = this.extractResponseParts(response);
            if (!text) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const tokenUsage = this.extractTokenUsage(response);

            this.logReply(text, reasoningSummary, tokenUsage);

            return [text, reasoningSummary, tokenUsage, encryptedReasoning];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            throw new Error(this.errorMessages.apiError(error));
        }
    }

    private createResponse(input: any[], zodSchema?: z.ZodSchema): Promise<any> {
        return this.client.responses.create({
            model: this.model,
            temperature: this.temperature,
            input,
            // Reasoning bills against the output budget on top of the visible answer, so this
            // has to cover both. Raise it with a catalog `maxOutputTokens` override if Muse
            // ever starts truncating.
            max_output_tokens: this.maxOutputTokens,
            // Effort read at request time so a per-instance override (story generation runs
            // deeper) is honored; omitted entirely when nothing is pinned, leaving Meta's default.
            reasoning: {
                ...(this.reasoningEffort ? { effort: toMetaEffort(this.reasoningEffort) } : {}),
                summary: 'auto',
            },
            // We manage conversation state ourselves; encrypted reasoning is only
            // returned for unstored responses.
            store: false,
            include: ["reasoning.encrypted_content"],
            prompt_cache_key: this.promptCacheKey,
            ...(zodSchema ? {
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'response_schema',
                        schema: ZodSchemaConverter.toJsonSchema(zodSchema),
                        strict: false,
                    },
                },
            } : {}),
        } as any);
    }

    /**
     * Converts history to Responses API input items. The system instruction is merged into
     * the leading system message; assistant messages carrying stored encrypted reasoning get
     * their reasoning items replayed right before them.
     */
    private buildResponsesInput(messages: AIMessage[]): any[] {
        const input: any[] = [];

        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.metaEncryptedReasoning) {
                try {
                    const reasoningItems = JSON.parse(msg.metaEncryptedReasoning);
                    if (Array.isArray(reasoningItems)) {
                        input.push(...reasoningItems);
                    }
                } catch {
                    this.logger(`Failed to parse stored encrypted reasoning, replaying message without it`);
                }
            }
            input.push({ role: msg.role, content: msg.content });
        }

        if (input.length > 0 && input[0].role !== 'system') {
            input.unshift({ role: 'system', content: this.instruction });
        } else if (input.length > 0 && input[0].role === 'system') {
            input[0].content = `${this.instruction}\n\n${input[0].content}`;
        }

        return input;
    }

    /**
     * Walks the response output items: reasoning items yield the human-readable summary
     * plus the encrypted items (serialized for storage/replay); message items yield text.
     */
    private extractResponseParts(response: any): { text: string; reasoningSummary: string; encryptedReasoning?: string } {
        const textParts: string[] = [];
        const summaryParts: string[] = [];
        const encryptedItems: any[] = [];

        for (const item of response?.output ?? []) {
            if (!item) {
                continue;
            }
            if (item.type === 'reasoning') {
                for (const summary of item.summary ?? []) {
                    if (typeof summary?.text === 'string' && summary.text) {
                        summaryParts.push(summary.text);
                    }
                }
                if (item.encrypted_content) {
                    encryptedItems.push(item);
                }
            } else if (item.type === 'message') {
                for (const part of item.content ?? []) {
                    if (part?.type === 'output_text' && typeof part.text === 'string') {
                        textParts.push(part.text);
                    }
                }
            }
        }

        return {
            text: textParts.join('\n').trim(),
            reasoningSummary: summaryParts.join('\n').trim(),
            encryptedReasoning: encryptedItems.length > 0 ? JSON.stringify(encryptedItems) : undefined,
        };
    }

    private extractTokenUsage(response: any): TokenUsage | undefined {
        const usage = response?.usage;
        if (!usage) {
            return undefined;
        }

        const inputTokens = usage.input_tokens || 0;
        // Responses API output_tokens already includes reasoning tokens
        const outputTokens = usage.output_tokens || 0;
        const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
        const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;

        const cost = calculateMetaCost(this.model, inputTokens, outputTokens, cachedTokens);

        if (reasoningTokens > 0) {
            this.logger(`Output breakdown: ${reasoningTokens} reasoning tokens, ${outputTokens - reasoningTokens} final answer tokens, ${outputTokens} total output tokens`);
        }
        if (cachedTokens > 0) {
            this.logger(`Input breakdown: ${cachedTokens} cached tokens of ${inputTokens} input tokens`);
        }

        return {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUSD: cost,
            // Omitted when zero so we never hand Firestore an undefined value.
            ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
            ...(cachedTokens > 0 ? { cachedInputTokens: cachedTokens } : {})
        };
    }
}
