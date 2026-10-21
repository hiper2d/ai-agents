/**
 * Image-generation models: platform-side, never user-selected. Prices per 1M tokens from
 * ai.google.dev/gemini-api/docs/pricing.
 *
 * Nano Banana 2.1 (default since 0.26.0, 2026-10-20): image output bills by size — 1120
 * tokens at 1K, 1680 at 2K, 3780 at 4K — and the model thinks before drawing, which bills
 * as TEXT output (~650-750 thought tokens at the default `medium` level, none at `minimal`;
 * measured live 2026-10-20). One 1K image ≈ $0.040, one 2K image ≈ $0.058.
 *
 * Gemini 3.1 Flash Image (the previous default, kept selectable) bills a flat ~1120 image
 * tokens regardless of size, ≈ $0.067 an image.
 */
export const IMAGE_MODEL_CONSTANTS = {
    GEMINI_NANO_BANANA: 'gemini-nano-banana-2.1',
    GEMINI_FLASH_IMAGE: 'gemini-3.1-flash-image',
} as const;

export type ImageModelId = typeof IMAGE_MODEL_CONSTANTS[keyof typeof IMAGE_MODEL_CONSTANTS];

export interface ImageModelPricing {
    imageOutputPricePerM: number;
    textInputPricePerM: number;
    /** Text and thinking output. Absent = the model bills none (or we never measured it). */
    textOutputPricePerM?: number;
}

export const IMAGE_MODEL_PRICING: Record<ImageModelId, ImageModelPricing> = {
    [IMAGE_MODEL_CONSTANTS.GEMINI_NANO_BANANA]: {
        imageOutputPricePerM: 30,
        textInputPricePerM: 1.5,
        textOutputPricePerM: 7.5,
    },
    [IMAGE_MODEL_CONSTANTS.GEMINI_FLASH_IMAGE]: {
        imageOutputPricePerM: 60,
        textInputPricePerM: 0.5,
    },
};

export const DEFAULT_IMAGE_MODEL: ImageModelId = IMAGE_MODEL_CONSTANTS.GEMINI_NANO_BANANA;

/**
 * Cost of one image call from the usage Gemini reports. `textOutputTokens` is the text
 * the model wrote next to the image plus its thought tokens.
 */
export function calculateImageCost(model: ImageModelId, imageOutputTokens: number, textInputTokens: number, textOutputTokens: number = 0): number {
    const pricing = IMAGE_MODEL_PRICING[model];
    return parseFloat((
        imageOutputTokens / 1_000_000 * pricing.imageOutputPricePerM +
        textInputTokens / 1_000_000 * pricing.textInputPricePerM +
        textOutputTokens / 1_000_000 * (pricing.textOutputPricePerM ?? 0)
    ).toFixed(6));
}
