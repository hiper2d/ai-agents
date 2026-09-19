import type { ReasoningEffort } from './catalog';

/**
 * Per-provider reasoning-effort vocabularies.
 *
 * `ReasoningEffort` (catalog.ts) is the union of every provider's scale so a catalog entry or
 * a per-call override can name any level; each provider accepts only its own slice and most
 * reject the rest with a 400. The `to<Provider>Effort` helpers clamp a generic level to the
 * nearest one the provider takes, so a consumer can say "high" for every model and let the
 * agent translate. Nearest is by rank on the shared scale; a tie resolves upward (asking for
 * "medium" from a provider with only low|high gets high — never less reasoning than asked).
 *
 * Verified against provider docs 2026-08-30:
 * - OpenAI GPT-5.x: minimal|low|medium|high|xhigh
 * - Anthropic adaptive thinking (Fable 5 / Opus 4.8 / Sonnet 5): low|medium|high|xhigh|max
 * - Gemini 3.x thinkingLevel: minimal|low|medium|high (3.1 Pro and 3.7 Flash reject minimal)
 * - Z.AI GLM-5.3 / 5.3-Flash: low|high|max only
 * - DeepSeek V4: low|high|max (the API itself aliases medium → high)
 * - Sakana Fugu: high|xhigh
 * - Meta Muse Spark (verified 2026-09-12): minimal|low|medium|high|xhigh|max ("none" → 400; max is
 *   Standard tier only)
 * - Mistral Small 4 / Medium 3.5 (verified 2026-09-18): the API enum is
 *   none|minimal|low|medium|high|xhigh, with reasoning OFF unless the field is sent. "none" is
 *   not on the shared scale and means "don't reason", which an agent expresses by omitting the
 *   field, so the exported slice starts at minimal. Only "high" is documented to return the
 *   thinking chunk; the intermediate levels are accepted but unverified.
 * Qwen accepts reasoning_effort but ignores it (thinking_budget is its knob); MiniMax, Kimi and
 * Grok expose no effort parameter.
 */
export type OpenAIReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type AnthropicReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type GeminiReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
export type GlmReasoningEffort = 'low' | 'high' | 'max';
export type DeepSeekReasoningEffort = 'low' | 'high' | 'max';
export type FuguReasoningEffort = 'high' | 'xhigh';
export type MetaReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type MistralReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** The shared scale, lowest first. */
export const REASONING_EFFORT_SCALE: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const OPENAI_REASONING_EFFORTS: readonly OpenAIReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
export const ANTHROPIC_REASONING_EFFORTS: readonly AnthropicReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const GEMINI_REASONING_EFFORTS: readonly GeminiReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
export const GLM_REASONING_EFFORTS: readonly GlmReasoningEffort[] = ['low', 'high', 'max'];
export const DEEPSEEK_REASONING_EFFORTS: readonly DeepSeekReasoningEffort[] = ['low', 'high', 'max'];
export const FUGU_REASONING_EFFORTS: readonly FuguReasoningEffort[] = ['high', 'xhigh'];
export const META_REASONING_EFFORTS: readonly MetaReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MISTRAL_REASONING_EFFORTS: readonly MistralReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/** Clamps `effort` to the nearest level in `allowed` (by rank on the shared scale, ties go up). */
export function clampReasoningEffort<T extends ReasoningEffort>(effort: ReasoningEffort, allowed: readonly T[]): T {
    const rank = REASONING_EFFORT_SCALE.indexOf(effort);
    let best: T = allowed[0];
    let bestDistance = Infinity;
    for (const candidate of allowed) {
        const distance = Math.abs(REASONING_EFFORT_SCALE.indexOf(candidate) - rank);
        // Strictly closer wins; an equally close candidate wins only if it ranks higher.
        if (distance < bestDistance || (distance === bestDistance && REASONING_EFFORT_SCALE.indexOf(candidate) > REASONING_EFFORT_SCALE.indexOf(best))) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

export const toOpenAIEffort = (effort: ReasoningEffort): OpenAIReasoningEffort => clampReasoningEffort(effort, OPENAI_REASONING_EFFORTS);
export const toAnthropicEffort = (effort: ReasoningEffort): AnthropicReasoningEffort => clampReasoningEffort(effort, ANTHROPIC_REASONING_EFFORTS);
export const toGeminiEffort = (effort: ReasoningEffort): GeminiReasoningEffort => clampReasoningEffort(effort, GEMINI_REASONING_EFFORTS);
export const toGlmEffort = (effort: ReasoningEffort): GlmReasoningEffort => clampReasoningEffort(effort, GLM_REASONING_EFFORTS);
export const toDeepSeekEffort = (effort: ReasoningEffort): DeepSeekReasoningEffort => clampReasoningEffort(effort, DEEPSEEK_REASONING_EFFORTS);
export const toMetaEffort = (effort: ReasoningEffort): MetaReasoningEffort => clampReasoningEffort(effort, META_REASONING_EFFORTS);
export const toFuguEffort = (effort: ReasoningEffort): FuguReasoningEffort => clampReasoningEffort(effort, FUGU_REASONING_EFFORTS);
export const toMistralEffort = (effort: ReasoningEffort): MistralReasoningEffort => clampReasoningEffort(effort, MISTRAL_REASONING_EFFORTS);
