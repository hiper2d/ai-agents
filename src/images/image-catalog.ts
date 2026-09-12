/**
 * Image-generation models: platform-side, never user-selected. Prices per 1M tokens
 * from ai.google.dev/gemini-api/docs/pricing (2026-08). Image output bills ~1120 tokens
 * per image regardless of resolution, so one image ≈ $0.067 — fewer calls, not lower
 * resolution, is what minimizes cost.
 */
export const IMAGE_MODEL_CONSTANTS = {
    GEMINI_FLASH_IMAGE: 'gemini-3.1-flash-image',
} as const;

export type ImageModelId = typeof IMAGE_MODEL_CONSTANTS[keyof typeof IMAGE_MODEL_CONSTANTS];

export interface ImageModelPricing {
    imageOutputPricePerM: number;
    textInputPricePerM: number;
}

export const IMAGE_MODEL_PRICING: Record<ImageModelId, ImageModelPricing> = {
    [IMAGE_MODEL_CONSTANTS.GEMINI_FLASH_IMAGE]: {
        imageOutputPricePerM: 60,
        textInputPricePerM: 0.5,
    },
};

export const DEFAULT_IMAGE_MODEL: ImageModelId = IMAGE_MODEL_CONSTANTS.GEMINI_FLASH_IMAGE;

/** Cost of one image call from the usage Gemini reports. */
export function calculateImageCost(model: ImageModelId, imageOutputTokens: number, textInputTokens: number): number {
    const pricing = IMAGE_MODEL_PRICING[model];
    return parseFloat((
        imageOutputTokens / 1_000_000 * pricing.imageOutputPricePerM +
        textInputTokens / 1_000_000 * pricing.textInputPricePerM
    ).toFixed(6));
}
