/**
 * Custom error classes for AI agent interactions
 */

export abstract class ModelError extends Error {
    public modelType: string;

    constructor(message: string, modelType: string) {
        super(message);
        this.modelType = modelType;
    }
}

export class ModelOverloadError extends ModelError {
    public retryable: boolean;

    constructor(
        message: string,
        modelType: string,
        retryable: boolean = true
    ) {
        super(message, modelType);
        this.name = 'ModelOverloadError';
        this.retryable = retryable;
    }
}

export class ModelRateLimitError extends ModelError {
    public retryAfter?: number; // seconds to wait before retrying

    constructor(
        message: string,
        modelType: string,
        retryAfter?: number
    ) {
        super(message, modelType);
        this.name = 'ModelRateLimitError';
        this.retryAfter = retryAfter;
    }
}

export class ModelUnavailableError extends ModelError {
    public reason: string;

    constructor(
        message: string,
        modelType: string,
        reason: string = 'unknown'
    ) {
        super(message, modelType);
        this.name = 'ModelUnavailableError';
        this.reason = reason;
    }
}

export class ModelAuthenticationError extends ModelError {
    constructor(
        message: string,
        modelType: string
    ) {
        super(message, modelType);
        this.name = 'ModelAuthenticationError';
    }
}

export class ModelQuotaExceededError extends ModelError {
    constructor(
        message: string,
        modelType: string
    ) {
        super(message, modelType);
        this.name = 'ModelQuotaExceededError';
    }
}

/**
 * The model failed to produce a valid response: the output was malformed (unparseable
 * JSON from a structured-output ask) or cut off at the output-token cap before the
 * answer was complete (`status: "incomplete"` on the OpenAI Responses API). Not a
 * transport or availability problem — the request worked, the generation went wrong.
 * A retry with the same prompt often succeeds; `truncated` distinguishes a cap hit
 * (raise maxOutputTokens if legitimate responses genuinely need more room) from a
 * degenerate/runaway generation (a bigger cap only makes failures slower).
 */
export class ModelInvalidResponseError extends ModelError {
    public truncated: boolean;

    constructor(
        modelType: string,
        detail: string,
        truncated: boolean = false
    ) {
        super(`${modelType} failed to produce a valid response: ${detail}`, modelType);
        this.name = 'ModelInvalidResponseError';
        this.truncated = truncated;
    }
}

/**
 * The model declined to answer. Not retryable as-is — the same prompt will refuse again —
 * the caller has to change the prompt or the model. `reason` is the provider's own label
 * for the refusal, when it gives one:
 *
 *   Anthropic  `stop_reason: "refusal"` with no content blocks when its safety layer rejects
 *              the request as a whole. Observed 2026-08-30 on Claude Fable 5: a persona
 *              system prompt plus a narrated multi-turn history that ends by asking the
 *              character what it does refuses, while either half alone answers; Sonnet 5
 *              and Opus 4.8 answer the same requests. `reason` = "refusal".
 *   Google     a 200 with no candidates and `promptFeedback.blockReason` set (the prompt
 *              itself was rejected: PROHIBITED_CONTENT, SAFETY, BLOCKLIST, JAILBREAK,
 *              MODEL_ARMOR, OTHER), or a candidate whose `finishReason` is a content
 *              block (SAFETY, PROHIBITED_CONTENT, BLOCKLIST, RECITATION, SPII,
 *              IMAGE_SAFETY, ...). Observed 2026-09-13 in production: an explicit
 *              sexual roleplay game was refused by Gemini 3.8 Flash and 3.1 Pro with
 *              blockReason PROHIBITED_CONTENT in ~200ms and zero output tokens, while
 *              Mistral, MiniMax and Muse answered the same prompt. PROHIBITED_CONTENT is
 *              Google's non-configurable filter — no safetySettings change lifts it.
 *              `reason` = the blockReason or finishReason string.
 */
export class ModelRefusalError extends ModelError {
    public reason?: string;

    constructor(modelType: string, message: string = `${modelType} refused to answer (stop_reason: refusal)`, reason?: string) {
        super(message, modelType);
        this.name = 'ModelRefusalError';
        this.reason = reason;
    }
}
