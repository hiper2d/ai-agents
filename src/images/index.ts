/**
 * `@hiper2d/ai-agents/images` — image generation and portrait sheets.
 *
 * Kept off the main entry on purpose: this subpath is for hosts that draw pictures.
 * It never imports sharp (the host passes its own instance in), so nothing native
 * rides along, and the geometry helpers are pure and safe in a browser bundle.
 */
export type {
    ImageRect, ImageSize, AvatarCircle, AvatarFraming, ImageFocus,
    PortraitCell, PortraitSlice, DrawnSheet, GeneratedImage, SharpLike, SharpPipeline,
} from './types';
export {
    CARD_ASPECT, CARD_WIDTH_PX, CARD_HEIGHT_PX, DEFAULT_AVATAR_CIRCLE, MIN_CARD_HEIGHT_FRACTION,
} from './types';

export {
    cardInCell, defaultFraming, fitCircle, fitCard, fitFraming, isFramingShape,
    circleFocus, cardFocus, circleFocusOnSheet, focusToBackground,
} from './framing';

export { findDividers, equalSplitGrid, detectSheetGrid, describeDividers } from './sheet-detection';
export type { GreyPlane, SheetGrid } from './sheet-detection';

export {
    IMAGE_MODEL_CONSTANTS, IMAGE_MODEL_PRICING, DEFAULT_IMAGE_MODEL, calculateImageCost,
} from './image-catalog';
export type { ImageModelId, ImageModelPricing } from './image-catalog';

export { generateImage } from './google-image';
export type { GenerateImageOptions, ImageAspectRatio } from './google-image';

export {
    gridFor, padCells, buildPortraitSheetPrompt, sliceSheet, cutCard, drawPortraitSheet,
    DEFAULT_FILLER_PROMPT, SHEET_MAX_WIDTH, SHEET_JPEG_QUALITY, SHEET_MAX_BASE64_BYTES,
} from './portrait-sheet';
export type {
    PortraitSheetPrompt, SheetMismatch, SliceSheetOptions,
    DrawPortraitSheetSpec, DrawPortraitSheetOptions, DrawnPortraitSheet,
} from './portrait-sheet';
