import { AIMessage, TokenUsage, AgentLoggingConfig, DEFAULT_LOGGING_CONFIG } from "../types";
import { z } from 'zod';
import { logger } from "../logger";
import { CACHE_TIER_MARKER } from "../cache-tier";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_REQUEST_TIMEOUT_MS, getModelConfigByApiName, ReasoningEffort } from "../catalog";
import { ModelInvalidResponseError, ModelTimeoutError } from "../errors";

/**
 * Runs before every ask on every LLM agent, with the agent about to call the provider.
 * Throw to refuse the call (nothing is sent). The intended use is budget control: a host
 * installs one hook that reads `agent.userId` and asserts the subject's spend budget, so
 * no call site can forget the check. Async hooks are awaited.
 */
export type BeforeAskHook = (agent: AbstractAgent) => void | Promise<void>;

let beforeAskHook: BeforeAskHook | undefined;

/** Install (or clear, with no argument) the process-wide pre-ask hook. Call once at startup. */
export function setBeforeAskHook(hook?: BeforeAskHook): void {
    beforeAskHook = hook;
}

/** Awaited once the ask a retry belonged to has settled (answered, or about to throw). */
export type RetrySettledFn = () => void | Promise<void>;

/**
 * Runs right before an ask is re-sent after an empty or malformed response (see
 * `AbstractAgent.invalidResponseRetries`); `attempt` counts retries from 1. The intended
 * use is a UI notice ("the model returned nothing, asking again"): return a function and it
 * is awaited when the whole ask settles, so the notice can be taken down again. A throwing
 * hook is logged and ignored — it never stops the retry. Async hooks are awaited.
 */
export type RetryHook = (info: {
    agent: AbstractAgent;
    model: string;
    error: ModelInvalidResponseError;
    attempt: number;
}) => void | RetrySettledFn | Promise<void | RetrySettledFn>;

let retryHook: RetryHook | undefined;

/** Install (or clear, with no argument) the process-wide retry hook. Call once at startup. */
export function setRetryHook(hook?: RetryHook): void {
    retryHook = hook;
}

export abstract class AbstractAgent {
    name: string;
    gameId?: string;
    userId?: string;
    /**
     * Output ceiling sent with every request from this agent. Resolved once from the model's
     * catalog override, else DEFAULT_MAX_OUTPUT_TOKENS. Callers needing more room raise it
     * after construction (see story generation), the same way gameId/userId are assigned —
     * so subclasses must read it when building a request, never snapshot it at construction.
     */
    maxOutputTokens: number;
    /**
     * Reasoning-depth knobs, resolved once from the catalog like maxOutputTokens and, like it,
     * overridable per instance for calls whose profile differs from a turn (story generation
     * runs deeper). Each provider speaks one dialect — effort (DeepSeek, GLM, Gemini, Claude
     * adaptive) or a token budget (Qwen, Claude Haiku 4.5) — and reads only the field it
     * understands; the other is ignored. Subclasses read these when building a request.
     */
    reasoningEffort?: ReasoningEffort;
    thinkingBudgetTokens?: number;
    /**
     * Wall-clock limit on one ask (DEFAULT_REQUEST_TIMEOUT_MS). Past it the ask throws
     * ModelTimeoutError; the provider request is abandoned, not cancelled. Raise it per
     * instance for calls that legitimately run long, like maxOutputTokens.
     */
    requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS;
    /**
     * How many times one ask is re-sent after a ModelInvalidResponseError that is not a
     * cap hit: the model answered with nothing, or with text that is not the JSON the
     * schema asked for. Those are one-off generation failures the same prompt usually
     * gets right on the next try, unlike timeouts, refusals and transport errors, which
     * are never retried here. 0 (the default) hands every failure to the caller. A
     * truncated response is excluded because re-running it re-buys the whole output at
     * the cap. Each re-send runs the before-ask hook again (it is a new paid call) and
     * fires the retry hook; the error finally thrown carries `retries`.
     */
    invalidResponseRetries: number = 0;
    protected readonly instruction: string;
    /**
     * The instruction split on CACHE_TIER_MARKER: [shared static tier, per-bot tier].
     * Length 1 when the prompt has no marker (GM prompts, tests). Providers with
     * explicit cache breakpoints (Anthropic) place one per part; everyone else uses
     * the joined marker-free `instruction`, whose shared prefix implicit caches match.
     */
    protected readonly instructionParts: string[];
    protected readonly temperature: number;
    protected readonly model: string;
    protected readonly enableThinking: boolean;
    protected readonly agentLoggingConfig: AgentLoggingConfig;

    protected constructor(
        name: string,
        instruction: string,
        model: string,
        temperature: number,
        enableThinking: boolean = false,
        agentLoggingConfig: AgentLoggingConfig = DEFAULT_LOGGING_CONFIG.agents
    ) {
        this.name = name;
        this.instructionParts = instruction
            .split(CACHE_TIER_MARKER)
            .filter(part => part.trim().length > 0);
        this.instruction = this.instructionParts.join('\n\n');
        this.temperature = temperature;
        this.model = model;
        this.enableThinking = enableThinking;
        this.agentLoggingConfig = agentLoggingConfig;
        const modelConfig = getModelConfigByApiName(model);
        this.maxOutputTokens = modelConfig?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        this.reasoningEffort = modelConfig?.reasoningEffort;
        this.thinkingBudgetTokens = modelConfig?.thinkingBudgetTokens;
    }

    /**
     * Public ask API — template methods that run the before-ask hook, time the provider
     * call, stamp `durationMs` into the returned TokenUsage and apply the
     * invalidResponseRetries policy. Subclasses implement doAskWithZodSchema/doAskText and
     * must NOT override these.
     */
    async askWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        return this.askWithRetries(() => this.doAskWithZodSchema(zodSchema, messages));
    }

    async askText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        return this.askWithRetries(() => this.doAskText(messages));
    }

    /**
     * One attempt per loop; an empty or malformed answer (ModelInvalidResponseError, not
     * truncated) is re-sent up to invalidResponseRetries times, with the retry hook told
     * before each re-send. Anything else — a timeout, a refusal, a transport error, or the
     * last allowed attempt failing — is thrown as-is, stamped with the retry count. Every
     * settle function the hook returned runs once the ask is over, whichever way it ended.
     */
    private async askWithRetries<R extends [unknown, string, TokenUsage?, string?]>(call: () => Promise<R>): Promise<R> {
        const settled: RetrySettledFn[] = [];
        let retries = 0;
        try {
            while (true) {
                try {
                    return await this.attempt(call);
                } catch (error) {
                    if (retries > 0 && error && typeof error === 'object') {
                        (error as { retries?: number }).retries = retries;
                    }
                    if (!(error instanceof ModelInvalidResponseError) || error.truncated || retries >= this.invalidResponseRetries) {
                        throw error;
                    }
                    retries++;
                    logger.warn(`${this.name} (${this.model}): ${error.message} — asking again (retry ${retries} of ${this.invalidResponseRetries})`, {
                        gameId: this.gameId,
                        userId: this.userId,
                        agentName: this.name,
                        model: this.model,
                        activity: 'llm_retry',
                        attempt: retries,
                        error: error.message,
                    });
                    if (retryHook) {
                        try {
                            const onSettled = await retryHook({ agent: this, model: this.model, error, attempt: retries });
                            if (typeof onSettled === 'function') settled.push(onSettled);
                        } catch (hookError) {
                            logger.warn(`${this.name} (${this.model}): retry hook failed, retrying anyway`, {
                                gameId: this.gameId, agentName: this.name, model: this.model,
                                error: hookError instanceof Error ? hookError.message : String(hookError),
                            });
                        }
                    }
                }
            }
        } finally {
            for (const onSettled of settled) {
                try {
                    await onSettled();
                } catch (hookError) {
                    logger.warn(`${this.name} (${this.model}): retry settle hook failed`, {
                        gameId: this.gameId, agentName: this.name, model: this.model,
                        error: hookError instanceof Error ? hookError.message : String(hookError),
                    });
                }
            }
        }
    }

    private async attempt<R extends [unknown, string, TokenUsage?, string?]>(call: () => Promise<R>): Promise<R> {
        if (beforeAskHook) await beforeAskHook(this);
        const startedAt = Date.now();
        try {
            const [content, thinking, usage, signature] = await this.withTimeout(call());
            return [content, thinking, this.stampDuration(usage, startedAt), signature] as unknown as R;
        } catch (error) {
            this.stampErrorDuration(error, startedAt);
            throw error;
        }
    }

    /**
     * Races the provider call against requestTimeoutMs. A hung provider (accepts the request,
     * never answers) otherwise runs until the host kills the function with no error to show.
     */
    private withTimeout<T>(call: Promise<T>): Promise<T> {
        const timeoutMs = this.requestTimeoutMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ModelTimeoutError(this.model, timeoutMs)), timeoutMs);
        });
        return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
    }

    private stampDuration(usage: TokenUsage | undefined, startedAt: number): TokenUsage | undefined {
        return usage ? { ...usage, durationMs: Date.now() - startedAt } : usage;
    }

    /** Failed calls carry their duration too — a 35s provider stall that errors is still signal. */
    private stampErrorDuration(error: unknown, startedAt: number): void {
        if (error && typeof error === 'object') {
            (error as { durationMs?: number }).durationMs = Date.now() - startedAt;
        }
    }

    protected abstract doAskWithZodSchema<T>(zodSchema: z.ZodSchema<T>, messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]>;

    /**
     * Plain-text ask: no schema appended to the prompt, no JSON mode, no parsing.
     * Returns [content, thinkingContent, tokenUsage?, thinkingSignature?] — same tuple
     * shape as doAskWithZodSchema but with the raw response string as content.
     * Implementations must throw on empty content so the recoverable-error/retry UX
     * is preserved (errors surface in the UI; the user triggers retries).
     */
    protected abstract doAskText(messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]>;

    protected logger(message: string): void {
        console.log(`[${this.name} ${this.model}]: ${message}`);
    }

    protected logAsking(messages: AIMessage[]): void {
        this.logger("==================================================");
        this.logger(`Asking ${this.name} ${this.model} agent`);
        this.logger("==================================================");
        
        logger.agentActivity(this.name, this.model, 'REQUEST', {
            gameId: this.gameId,
            userId: this.userId,
            systemPrompt: this.instruction,
            history: messages,
            command: messages.length > 0 ? messages[messages.length - 1].content : undefined
        }, this.agentLoggingConfig);
    }

    protected logSystemPrompt(): void {
        // No longer needed as it's included in logAsking's structured log
        // Keeping it for backward compatibility with subclasses that might call it
    }

    protected logMessages(messages: AIMessage[]): void {
        // Console logging still useful for local dev
        this.logger(`History for ${this.name}:`);
        messages.forEach((msg, index) => {
            const preview = msg.content.length > 1000 ? msg.content.substring(0, 1000) + '...' : msg.content;
            this.logger(`  ${index + 1}. [${msg.role}]: ${preview}`);
        });
    }

    protected logReply(reply: any, thinking?: string, usage?: TokenUsage): void {
        const replyStr = typeof reply === 'string' ? reply : JSON.stringify(reply);
        
        // Console logging
        this.logger(`Reply from ${this.name}:`);
        if (thinking) {
            const thinkingPreview = thinking.length > 500 ? thinking.substring(0, 500) + '...' : thinking;
            this.logger(`  [thinking]: ${thinkingPreview}`);
        }
        const preview = replyStr.length > 1000 ? replyStr.substring(0, 1000) + '...' : replyStr;
        this.logger(`  [assistant]: ${preview}`);

        logger.agentActivity(this.name, this.model, 'RESPONSE', {
            gameId: this.gameId,
            userId: this.userId,
            reply,
            thinking,
            usage
        }, this.agentLoggingConfig);
    }


    /**
     * Merges consecutive user messages (e.g. a GM command followed by the detached
     * reminder postfix) into one, for providers that expect alternating roles — this
     * reproduces the pre-detachment request shape. ClaudeAgent overrides this to keep
     * them separate: Anthropic combines consecutive user turns into one turn but keeps
     * distinct content blocks, which lets its fast cache breakpoint sit on the persisted
     * command block while the throwaway reminder rides behind it.
     */
    protected prepareMessages(messages: AIMessage[]): AIMessage[] {
        const result: AIMessage[] = [];
        for (const msg of messages) {
            const prev = result[result.length - 1];
            if (prev && prev.role === 'user' && msg.role === 'user') {
                result[result.length - 1] = { ...prev, content: `${prev.content}\n\n${msg.content}` };
            } else {
                result.push(msg);
            }
        }
        return result;
    }
}
