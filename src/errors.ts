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
 * The model declined to answer: Anthropic returns `stop_reason: "refusal"` with no content
 * blocks when its safety layer rejects the request as a whole. Not retryable as-is — the
 * same prompt will refuse again — the caller has to change the prompt or the model.
 * Observed 2026-08-30 on Claude Fable 5: a persona system prompt plus a narrated multi-turn
 * history that ends by asking the character what it does refuses, while either half alone
 * answers; Sonnet 5 and Opus 4.8 answer the same requests.
 */
export class ModelRefusalError extends ModelError {
    constructor(modelType: string, message: string = `${modelType} refused to answer (stop_reason: refusal)`) {
        super(message, modelType);
        this.name = 'ModelRefusalError';
    }
}
