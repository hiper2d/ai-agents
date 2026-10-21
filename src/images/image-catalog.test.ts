import { calculateImageCost, DEFAULT_IMAGE_MODEL, IMAGE_MODEL_CONSTANTS, IMAGE_MODEL_PRICING } from './image-catalog';

/** Pins the per-image prices from ai.google.dev/gemini-api/docs/pricing (read 2026-10-20). */
describe('image catalog pricing', () => {
    it('defaults to Nano Banana 2.1', () => {
        expect(DEFAULT_IMAGE_MODEL).toBe('gemini-nano-banana-2.1');
        expect(Object.keys(IMAGE_MODEL_PRICING).sort()).toEqual(['gemini-3.1-flash-image', 'gemini-nano-banana-2.1']);
    });

    it.each([
        ['1K', 1120, 0.0336],
        ['2K', 1680, 0.0504],
        ['4K', 3780, 0.1134],
    ])('prices a %s Nano Banana image at the documented per-image figure', (_size, tokens, usd) => {
        expect(calculateImageCost(IMAGE_MODEL_CONSTANTS.GEMINI_NANO_BANANA, tokens, 0)).toBeCloseTo(usd, 4);
    });

    it('bills thought and text output at the text rate, only where the model has one', () => {
        const nano = calculateImageCost(IMAGE_MODEL_CONSTANTS.GEMINI_NANO_BANANA, 1120, 0, 700);
        expect(nano).toBeCloseTo(0.0336 + 0.00525, 6);
        const flash = calculateImageCost(IMAGE_MODEL_CONSTANTS.GEMINI_FLASH_IMAGE, 1120, 0, 700);
        expect(flash).toBeCloseTo(0.0672, 6);
    });
});
