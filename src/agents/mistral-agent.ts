import { AbstractAgent } from "./abstract-agent";
import { stableHashHex } from "../text-utils";
import { Mistral } from "@mistralai/mistralai";
import { HTTPClient } from "@mistralai/mistralai/lib/http.js";
import { ChatCompletionResponse, ContentChunk } from "@mistralai/mistralai/models/components";
import { AIMessage, MESSAGE_ROLE, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG } from "../types";
import { cleanResponse } from "../text-utils";
import { z } from 'zod';
import { ZodSchemaConverter } from '../zod-schema-converter';
import { parseAndValidateLlmJson } from '../json-response-parser';
import { extractMistralTokenUsage, calculateCost } from '../pricing/token-usage-utils';
import { toMistralEffort } from '../reasoning-effort';

type MistralMessage = Parameters<Mistral['chat']['complete']>[0]['messages'][number];

/**
 * Mistral agent (Mistral SDK chat.complete) for the hybrid Small 4 / Medium 3.5 models.
 *
 * Reasoning is off on the API by default and switched on per request with `reasoning_effort`
 * (docs.mistral.ai/studio/conversations/reasoning). SDK 1.x has no typed field for it, so it is
 * injected into the wire body by the same beforeRequest hook that adds `prompt_cache_key`.
 * With it set, the assistant message comes back as content chunks — a `thinking` chunk (a list
 * of text chunks holding the trace) followed by the `text` answer — and this works together
 * with json_schema structured output (verified live 2026-09-18 on both models). Without the
 * field the reply is a plain string and no trace exists.
 *
 * Multi-turn: Mistral asks that the full assistant message, thinking chunk included, be
 * replayed into history ("stripping reasoning traces degrades performance"). The trace is
 * plain text, so it rides on `AIMessage.thinking` — no provider signature field — and
 * convertToMistralMessages rebuilds each prior assistant turn as [thinking, text] chunks.
 *
 * Reasoning tokens are counted inside completion_tokens; no separate reasoning_tokens field
 * arrives, so cost accounting on the output rate already covers the trace.
 */
export class MistralAgent extends AbstractAgent {
    private readonly client: Mistral;
    // A getter, not a field: `maxOutputTokens` can be raised after construction, and a field
    // initializer would snapshot the default and silently ignore the override.
    private get defaultParams(): Omit<Parameters<Mistral['chat']['complete']>[0], 'messages'> {
        return {
            model: this.model,
            maxTokens: this.maxOutputTokens,
            temperature: this.temperature,
        };
    }

    // Log message templates
    private readonly logTemplates = {
        error: (name: string, error: unknown) => `Error in ${name} agent: ${error}`,
    };

    // Error message templates
    private readonly errorMessages = {
        emptyResponse: 'Empty or undefined response from Mistral API',
        invalidFormat: 'Invalid response format from Mistral API',
        apiError: (error: unknown) =>
            `Failed to get response from Mistral API: ${error instanceof Error ? error.message : String(error)}`,
    };


    constructor(
        name: string, 
        instruction: string, 
        model: string, 
        apiKey: string, 
        enableThinking: boolean = false,
        agentLoggingConfig: AgentLoggingConfig = DEFAULT_LOGGING_CONFIG.agents
    ) {
        super(name, instruction, model, 0.7, enableThinking, agentLoggingConfig);

        // Two request params SDK 1.x has no typed field for (its outbound zod schema strips
        // unknown keys), injected into the wire body via the beforeRequest hook instead:
        // - `prompt_cache_key`: Mistral's cache hint ("use the same key for requests with
        //   shared prompt prefixes ... to increase cache hits"), derived from bot identity +
        //   system prompt so it is stable within a game day.
        // - `reasoning_effort`: turns reasoning on. Read at request time (not captured here) so
        //   a per-instance `reasoningEffort` override set after construction is honoured.
        //   Omitted when thinking is disabled — the API's default is no reasoning.
        // Any failure falls back to sending the request untouched.
        const promptCacheKey = stableHashHex(`${name}\n${instruction}`);
        const httpClient = new HTTPClient();
        httpClient.addHook("beforeRequest", async (request) => {
            try {
                if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/chat/completions')) {
                    const body = await request.clone().text();
                    const json = JSON.parse(body);
                    json.prompt_cache_key = promptCacheKey;
                    if (this.enableThinking && this.reasoningEffort) {
                        json.reasoning_effort = toMistralEffort(this.reasoningEffort);
                    }
                    return new Request(request.url, {
                        method: request.method,
                        headers: request.headers,
                        body: JSON.stringify(json),
                    });
                }
            } catch {
                // fall through to the original request
            }
            return request;
        });
        this.client = new Mistral({ apiKey: apiKey, httpClient });
    }

    /**
     * History in Mistral's shape. A prior assistant turn that carries a stored trace is
     * replayed as [thinking, text] chunks, as Mistral's multi-turn guidance asks; every other
     * turn is a plain string.
     */
    private convertToMistralMessages(messages: AIMessage[]): MistralMessage[] {
        return this.prepareMessages(messages).map((msg): MistralMessage => {
            if (msg.role === 'assistant' && msg.thinking) {
                const chunks: ContentChunk[] = [
                    { type: 'thinking', thinking: [{ type: 'text', text: msg.thinking }] },
                    { type: 'text', text: msg.content },
                ];
                return { role: 'assistant', content: chunks };
            }
            return {
                role: msg.role === 'developer' ? 'system' : msg.role,
                content: msg.content,
            };
        });
    }


    private processReply(response: ChatCompletionResponse | undefined): [string, string, TokenUsage?] {
        const message = response?.choices?.[0]?.message;

        if (!message || !message.content) {
            throw new Error(this.errorMessages.emptyResponse);
        }

        let reply = message.content;

        // Reasoning on: [thinking, text] chunk array
        if (Array.isArray(reply)) {
            const { content, thinking } = this.processStructuredReply(reply);

            if (this.enableThinking && thinking) {
                this.logger(`Thinking content: ${thinking.length} characters of reasoning`);
            }

            return [cleanResponse(content), thinking, this.extractTokenUsage(response)];
        }

        // Reasoning off: plain string
        return [cleanResponse(reply), "", this.extractTokenUsage(response)];
    }

    private processStructuredReply(reply: unknown[]): { content: string; thinking: string } {
        let content = "";
        let thinking = "";

        // Two chunks: the thinking block (a list of text chunks) and the text block
        for (const chunk of reply) {
            if (typeof chunk === "object" && chunk !== null && "type" in chunk) {
                if (chunk.type === "thinking" && "thinking" in chunk) {
                    // Extract thinking content from the thinking block
                    const thinkingArray = chunk.thinking as any[];
                    thinking = thinkingArray
                        .filter((item: any) => item?.type === "text" && item?.text)
                        .map((item: any) => item.text)
                        .join("");
                } else if (chunk.type === "text" && "text" in chunk) {
                    // Extract the final answer from the text block
                    content = chunk.text as string;
                }
            }
        }

        return { content, thinking };
    }

    private extractTokenUsage(response: ChatCompletionResponse | undefined): TokenUsage | undefined {
        // Use the centralized Mistral token usage extraction
        const usage = extractMistralTokenUsage(response);
        if (!usage) return undefined;

        // Reasoning tokens are not itemised by Mistral today (they sit inside completion_tokens);
        // logged if that ever changes.
        if (usage.reasoningTokens && usage.reasoningTokens > 0) {
            this.logger(`🧠 Reasoning tokens used: ${usage.reasoningTokens}`);
        }

        if (usage.cacheHitTokens && usage.cacheHitTokens > 0) {
            this.logger(`💾 Prompt cache: ${usage.cacheHitTokens} of ${usage.promptTokens} input tokens served from cache`);
        }

        // Calculate cost using centralized pricing from ai-models.ts
        const costUSD = calculateCost(this.model, usage.promptTokens, usage.completionTokens, {
            totalTokens: usage.totalTokens,
            cacheHitTokens: usage.cacheHitTokens || 0
        });

        return {
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            costUSD,
            // Omitted when absent so we never hand Firestore an undefined value.
            ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
            ...(usage.cacheHitTokens ? { cachedInputTokens: usage.cacheHitTokens } : {})
        };
    }

    /**
     * New method using Zod with Mistral API
     * This provides better schema handling and runtime validation
     *
     * Uses Mistral Custom Structured Outputs (responseFormat json_schema), which
     * enforces the response shape server-side and is more reliable than plain JSON
     * mode. The human-readable schema description is still appended to the last
     * message because the enforced schema omits field descriptions/semantics.
     */
    async doAskWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        try {
            // Convert Zod schema to human-readable prompt description
            const schemaDescription = ZodSchemaConverter.toPromptDescription(zodSchema);

            // Convert messages to Mistral format and add schema to last message
            const convertedMessages = this.convertToMistralMessages(messages);

            // Add schema description to the last message content (always a plain-string user
            // turn in practice; a chunked assistant turn is left alone).
            if (convertedMessages.length > 0) {
                const lastMessage = convertedMessages[convertedMessages.length - 1];
                if (lastMessage && typeof lastMessage.content === 'string' && lastMessage.content) {
                    lastMessage.content += `\n\nYour response must be a valid JSON object matching this schema:\n${schemaDescription}`;
                }
            } else {
                // If no messages, create a default user message with schema
                convertedMessages.push({
                    role: 'user',
                    content: `Please respond with a valid JSON object matching this schema:\n${schemaDescription}`
                });
            }

            // Prepare system message
            const systemMessage: MistralMessage = {
                role: MESSAGE_ROLE.SYSTEM,
                content: this.instruction
            };

            const allMessages: MistralMessage[] = [systemMessage, ...convertedMessages];

            // Build request parameters using Mistral Custom Structured Outputs.
            // json_schema enforces the response shape server-side; parseAndValidateLlmJson
            // below remains as a backstop for the rare case the model still drifts.
            const requestParams = {
                ...this.defaultParams,
                messages: allMessages,
                responseFormat: {
                    type: 'json_schema' as const,
                    jsonSchema: {
                        name: 'response_schema',
                        schemaDefinition: ZodSchemaConverter.toMistralSchema(zodSchema),
                        strict: true
                    }
                }
            };

            this.logAsking(messages);
            this.logMessages(messages);

            let response;
            try {
                response = await this.client.chat.complete(requestParams);
            } catch (apiError) {
                // Re-throw API errors immediately without wrapping them in schema validation errors
                this.logger(this.logTemplates.error(this.name, apiError));
                throw new Error(this.errorMessages.apiError(apiError));
            }

            if (!response || !response.choices || response.choices.length === 0) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            const choice = response.choices[0];
            const content = choice.message?.content;

            if (!content) {
                throw new Error(this.errorMessages.invalidFormat);
            }

            // With reasoning on the content is a [thinking, text] chunk array; a plain string
            // otherwise.
            let responseText: string;
            let thinkingContent = "";

            if (Array.isArray(content)) {
                const { content: extractedContent, thinking } = this.processStructuredReply(content);
                responseText = extractedContent;
                thinkingContent = thinking;
            } else if (typeof content === 'string') {
                responseText = content;
            } else {
                // Fallback for unexpected content types
                responseText = JSON.stringify(content);
            }

            // Parse and validate the response using the shared lenient parser
            // (handles Mistral's nested-reply-object quirk internally)
            const parsedData = parseAndValidateLlmJson(responseText, zodSchema, (m) => this.logger(m));

            this.logger(`✅ Response validated successfully with Zod schema`);

            // Extract token usage
            const tokenUsage = this.extractTokenUsage(response);

            if (parsedData) {
                this.logReply(parsedData, thinkingContent || undefined, tokenUsage);
            }

            return [parsedData, thinkingContent, tokenUsage];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            throw new Error(this.errorMessages.apiError(error));
        }
    }

    /**
     * Plain-text ask: no schema appended, no responseFormat. Reasoning (and the trace) works
     * the same way as on the schema path.
     */
    async doAskText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        try {
            const convertedMessages = this.convertToMistralMessages(messages);

            const systemMessage: MistralMessage = {
                role: MESSAGE_ROLE.SYSTEM,
                content: this.instruction
            };

            const requestParams = {
                ...this.defaultParams,
                messages: [systemMessage, ...convertedMessages] as MistralMessage[],
            };

            this.logAsking(messages);
            this.logMessages(messages);

            let response;
            try {
                response = await this.client.chat.complete(requestParams);
            } catch (apiError) {
                this.logger(this.logTemplates.error(this.name, apiError));
                throw new Error(this.errorMessages.apiError(apiError));
            }

            // processReply throws on empty content and handles structured (thinking) replies
            const [content, thinkingContent, tokenUsage] = this.processReply(response);

            if (!content) {
                throw new Error(this.errorMessages.emptyResponse);
            }

            this.logReply(content, thinkingContent || undefined, tokenUsage);

            return [content, thinkingContent, tokenUsage];

        } catch (error) {
            this.logger(this.logTemplates.error(this.name, error));
            throw new Error(this.errorMessages.apiError(error));
        }
    }
}