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
