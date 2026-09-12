/**
 * Shared shapes for the portrait-sheet pipeline. Coordinates are SHEET pixels unless
 * stated otherwise; a card is portrait 3:4 and the circle inside it is card-relative.
 */

/** A rectangle in image pixels (sharp's `extract` shape). */
export interface ImageRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface ImageSize {
    width: number;
    height: number;
}

/** The round avatar inside a card. `x` and `d` are fractions of the card's width,
 * `y` a fraction of its height. */
export interface AvatarCircle {
    x: number;
    y: number;
    d: number;
}

/** Where a portrait comes from on its sheet: the card cut and the circle in it. */
export interface AvatarFraming {
    card: ImageRect;
    circle: AvatarCircle;
}

/** The portion of an image to display, as fractions of its width/height. */
export interface ImageFocus {
    x: number;
    y: number;
    w: number;
    h: number;
}

// Cards are portrait 3:4 (a poster's shape), stored at this size.
export const CARD_ASPECT = 3 / 4; // width / height
export const CARD_WIDTH_PX = 600;
export const CARD_HEIGHT_PX = 800;
// Where the circle starts on a freshly cut card: 72% of its width, near the top.
export const DEFAULT_AVATAR_CIRCLE: AvatarCircle = { x: 0.14, y: 0.03, d: 0.72 };
// A card narrower than this fraction of the sheet's height upscales too much.
export const MIN_CARD_HEIGHT_FRACTION = 0.12;

/** One character on a portrait sheet. */
export interface PortraitCell {
    /** Stable id the caller stores the crop under; never drawn into the image. */
    key: string;
    /** Character name, for logs and prompt guidance; never drawn into the image. */
    label: string;
    /** One-line visual description for this cell (gender, name, appearance). */
    prompt: string;
}

/** A card cut from a drawn sheet. */
export interface PortraitSlice {
    key: string;
    label: string;
    jpeg: Buffer;
    /** The framing the slicer chose: the card on the sheet and the default circle. */
    framing: AvatarFraming;
}

/** The kept sheet: the grid image itself (re-encoded), its size and the cells
 * the cards were cut from — enough to re-cut any card later at a new framing. */
export interface DrawnSheet {
    jpeg: Buffer;
    width: number;
    height: number;
    cells: ImageRect[];
    /** false = no divider lines were found and the cells are the equal split of the
     * requested grid; true = the cells between the lines the model actually drew. */
    detected: boolean;
}

export interface GeneratedImage {
    buffer: Buffer;
    costUSD: number;
}

/**
 * The slice of sharp's API the pipeline uses. The library never imports sharp — a
 * native module the host installs and passes in (`(await import('sharp')).default`) —
 * so text-only consumers pull in nothing new.
 */
export type SharpLike = (input: Buffer) => {
    resize(options: { width: number; withoutEnlargement?: boolean }): SharpPipeline;
    resize(width: number, height: number): SharpPipeline;
    greyscale(): SharpPipeline;
    extract(rect: ImageRect): SharpPipeline;
    jpeg(options: { quality: number; mozjpeg?: boolean }): SharpPipeline;
    raw(): SharpPipeline;
    toBuffer(): Promise<Buffer>;
    toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
    metadata(): Promise<{ width?: number; height?: number }>;
};

export type SharpPipeline = ReturnType<SharpLike>;
