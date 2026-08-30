import {
    clampReasoningEffort,
    toAnthropicEffort,
    toDeepSeekEffort,
    toFuguEffort,
    toGeminiEffort,
    toGlmEffort,
    toOpenAIEffort,
    REASONING_EFFORT_SCALE,
} from './reasoning-effort';
import type { ReasoningEffort } from './catalog';

describe('reasoning effort clamping', () => {
    it('passes through values the provider accepts', () => {
        expect(toGlmEffort('low')).toBe('low');
        expect(toGlmEffort('max')).toBe('max');
        expect(toGeminiEffort('minimal')).toBe('minimal');
        expect(toOpenAIEffort('xhigh')).toBe('xhigh');
        expect(toAnthropicEffort('max')).toBe('max');
    });

    it('maps DeepSeek and GLM the way their docs alias: medium→high, xhigh→max, minimal→low', () => {
        for (const to of [toDeepSeekEffort, toGlmEffort]) {
            expect(to('medium')).toBe('high');
            expect(to('xhigh')).toBe('max');
            expect(to('minimal')).toBe('low');
        }
    });

    it('caps Gemini at high and OpenAI at xhigh', () => {
        expect(toGeminiEffort('xhigh')).toBe('high');
        expect(toGeminiEffort('max')).toBe('high');
        expect(toOpenAIEffort('max')).toBe('xhigh');
    });

    it('floors Anthropic at low and Fugu at high', () => {
        expect(toAnthropicEffort('minimal')).toBe('low');
        expect(toFuguEffort('low')).toBe('high');
        expect(toFuguEffort('max')).toBe('xhigh');
    });

    it('resolves ties upward, never below what was asked for', () => {
        // 'medium' sits exactly between low and high on a low|high scale.
        expect(clampReasoningEffort('medium', ['low', 'high'] as const)).toBe('high');
    });

    it('is total: every scale value maps to something for every provider', () => {
        for (const effort of REASONING_EFFORT_SCALE as ReasoningEffort[]) {
            for (const to of [toOpenAIEffort, toAnthropicEffort, toGeminiEffort, toGlmEffort, toDeepSeekEffort, toFuguEffort]) {
                expect(typeof to(effort)).toBe('string');
            }
        }
    });
});
