import { LLM_CONSTANTS, SupportedAiModels, MODEL_PRICING } from './catalog';

describe('catalog conventions', () => {
    it('every constant name is its id in upper snake case', () => {
        for (const [name, id] of Object.entries(LLM_CONSTANTS)) {
            expect(name).toBe(id.toUpperCase().replace(/-/g, '_'));
        }
    });

    it('ids are version-free (a bump must not require a consumer data migration)', () => {
        for (const id of Object.values(LLM_CONSTANTS)) {
            expect(id).not.toMatch(/\d/);
        }
    });

    it('every constant has a catalog entry and every catalog entry a price', () => {
        for (const id of Object.values(LLM_CONSTANTS)) {
            const config = SupportedAiModels[id];
            expect(config).toBeDefined();
            expect(MODEL_PRICING[config.modelApiName]).toBeDefined();
        }
    });
});

describe('enforcesSchema', () => {
    it('is true for providers that take a native JSON schema and false for the rest', () => {
        const { enforcesSchema, LLM_CONSTANTS } = require('./catalog');
        for (const id of [LLM_CONSTANTS.GPT, LLM_CONSTANTS.CLAUDE_HAIKU, LLM_CONSTANTS.GEMINI_FLASH, LLM_CONSTANTS.MISTRAL_SMALL, LLM_CONSTANTS.QWEN_FLASH, LLM_CONSTANTS.KIMI, LLM_CONSTANTS.MUSE_SPARK]) {
            expect(enforcesSchema(id)).toBe(true);
        }
        for (const id of [LLM_CONSTANTS.DEEPSEEK_FLASH, LLM_CONSTANTS.MINIMAX, LLM_CONSTANTS.GROK, LLM_CONSTANTS.GLM, LLM_CONSTANTS.FUGU_MAX, 'no-such-model']) {
            expect(enforcesSchema(id)).toBe(false);
        }
    });
});
