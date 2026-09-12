/**
 * Meta Model API (Muse Spark) pricing utilities
 * Re-exports unified utilities with Meta-specific naming, like the other providers
 */

import { calculateCost, extractMetaTokenUsage } from './token-usage-utils';

/**
 * Calculate the cost for token usage based on Meta pricing
 * @param model - The Meta model name (e.g. muse-spark-1.3)
 * @param inputTokens - Number of input tokens used (cached tokens are a subset of these)
 * @param outputTokens - Number of output tokens used (includes reasoning tokens)
 * @param cacheHitTokens - Number of cached input tokens (input_tokens_details.cached_tokens)
 * @returns Cost in USD
 */
export function calculateMetaCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheHitTokens: number = 0
): number {
    return calculateCost(model, inputTokens, outputTokens, { cacheHitTokens });
}

export interface MetaTokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens?: number;
    reasoningTokens?: number;
}

export function extractTokenUsageFromResponse(response: any): MetaTokenUsage | null {
    return extractMetaTokenUsage(response);
}
