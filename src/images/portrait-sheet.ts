import { generateImage, GenerateImageOptions } from './google-image';
import { defaultFraming } from './framing';
import { describeDividers, detectSheetGrid, equalSplitGrid } from './sheet-detection';
import { CARD_HEIGHT_PX, CARD_WIDTH_PX, DrawnSheet, ImageRect, PortraitCell, PortraitSlice, SharpLike } from './types';

/**
 * Portrait sheets: one image-model call draws a whole cast as a grid of bust
 * portraits, and the grid is cut into one card per character. One call costs the
 * same whether it draws one face or sixteen, so this is the cheap way to give
 * every character in a game a portrait in a single consistent style.
 *
 * Nothing here touches storage or billing: the host stores the cards and the kept
 * sheet (so a card can be re-cut later at a new framing) and charges whoever it
 * likes for `costUSD`. sharp is passed in, never imported.
 */

/**
 * Grid dimensions by cell count on the 4:3 canvas. Cells must come out
 * square-to-portrait: asked for 4x4 (landscape 600x448 cells) the model redrew the
 * sheet as 4x3, 6x3 and once as an irregular two-layout sheet — every time towards
 * taller cells. 5x3 keeps 480x597 cells for 13-15; 17 cells get 6x3 (400x600, 2:3,
 * one of the shapes the model volunteered). Never 4x4: it silently cut a 17-cell
 * cast to 16.
 */
export function gridFor(cells: number): { cols: number; rows: number } {
    if (cells <= 6) return { cols: 3, rows: 2 };
    if (cells <= 8) return { cols: 4, rows: 2 };
    if (cells <= 9) return { cols: 3, rows: 3 };
    if (cells <= 12) return { cols: 4, rows: 3 };
    if (cells <= 15) return { cols: 5, rows: 3 };
    if (cells <= 18) return { cols: 6, rows: 3 };
    throw new Error(`Portrait sheet cannot hold ${cells} cells (max 18)`);
}

export const DEFAULT_FILLER_PROMPT = `"Stranger" — an anonymous hooded figure fitting the setting, face hidden in shadow`;

/**
 * Pads a cast out to a full grid: the model draws exactly cols x rows cells, so the
 * spare ones get an anonymous filler that is drawn and discarded.
 */
export function padCells(cells: PortraitCell[], fillerPrompt: string = DEFAULT_FILLER_PROMPT): { cells: PortraitCell[]; cols: number; rows: number; realCount: number } {
    const { cols, rows } = gridFor(cells.length);
    const padded = [...cells];
    for (let i = padded.length; i < cols * rows; i++) {
        padded.push({ key: `__filler${i}`, label: 'Stranger', prompt: fillerPrompt });
    }
    return { cells: padded, cols, rows, realCount: cells.length };
}

export interface PortraitSheetPrompt {
    cells: PortraitCell[];
    cols: number;
    rows: number;
    /** What the sheet is for, e.g. "a social deduction game" — one noun phrase. */
    purpose: string;
    /** The world the characters live in: a title and a short description. */
    setting: { title: string; description: string };
    /** Player-chosen art direction, already sanitized by the host. Replaces the
     * model's free choice of style. */
    artStyle?: string;
}

/**
 * The sheet prompt. The wording is load-bearing: equal cells with thin dark
 * divider lines are what the slicer finds, one flat muted background per cell keeps
 * the lines detectable in any art style, and the no-text rule is repeated because
 * the model otherwise typesets names and bios into the image.
 */
export function buildPortraitSheetPrompt(spec: PortraitSheetPrompt): string {
    const { cells, cols, rows, purpose, setting, artStyle } = spec;
    const cellLines = cells.map(
        (c, i) => `Cell ${i + 1}: ${c.prompt}. Its own distinct flat solid muted background color.`
    ).join('\n');

    const styleLine = artStyle
        ? `Render every portrait in this art style, chosen by the player: "${artStyle}". Apply it consistently to every portrait: same rendering technique, same palette family, same lighting.`
        : `Choose ONE cohesive illustration style that fits this setting and apply it consistently to every portrait: same rendering technique, same palette family, same lighting.`;

    return `A character portrait sheet for ${purpose}, drawn as a single image: a precise grid of exactly ${cells.length} rectangular cells, ${cols} columns and ${rows} rows, all cells exactly equal size, separated by thin dark divider lines. Each cell contains one bust portrait (head and shoulders) of a different character, centered in its cell.

Setting — "${setting.title}": ${setting.description}

${styleLine} Every face must be distinct and memorable, and match its character description. No character may span more than one cell. Give each cell its own flat solid muted desaturated background color, different from its neighbors. Row-major order, left to right, top to bottom:

${cellLines}

The character descriptions above are guidance for the drawing only — NEVER render them as text. Absolutely no text anywhere in the image: no names, no labels, no captions, no letters, no writing of any kind — and no lettering on clothing, equipment, insignia or logos.`;
}

// The model returns ~2.4 MB loosely-compressed JPEGs; at this width and quality a
// sheet is ~400 KB (~530 KB as base64), under a 1 MiB document limit with cells
// still ~500 px tall.
export const SHEET_MAX_WIDTH = 2400;
export const SHEET_JPEG_QUALITY = 85;
export const SHEET_MAX_BASE64_BYTES = 900_000;

/** Why a sheet's cells did not come out as requested; the host decides how loudly to log. */
export interface SheetMismatch {
    kind: 'no-dividers' | 'different-grid';
    message: string;
    detail: Record<string, unknown>;
}

export interface SliceSheetOptions {
    onMismatch?: (mismatch: SheetMismatch) => void;
    /** Long edge the sheet is normalized to before cutting; defaults to SHEET_MAX_WIDTH. */
    maxWidth?: number;
}

/**
 * Cuts the cards out of a drawn sheet and keeps the sheet. Cells come from the
 * divider lines the model drew (equal split as a last resort); each card is the
 * largest 3:4 rectangle in its cell, top-anchored, with the default circle — the
 * framing the host can let a user move later.
 */
export async function sliceSheet(
    sharp: SharpLike,
    raw: Buffer,
    cells: PortraitCell[],
    count: number,
    cols: number,
    rows: number,
    opts: SliceSheetOptions = {},
): Promise<{ slices: PortraitSlice[]; sheet: DrawnSheet }> {
    // Normalise the working resolution first so cells, cards and the stored sheet
    // all share one pixel space.
    const grid: Buffer = await sharp(raw).resize({ width: opts.maxWidth ?? SHEET_MAX_WIDTH, withoutEnlargement: true }).toBuffer();
    const { data, info } = await sharp(grid).greyscale().raw().toBuffer({ resolveWithObject: true });
    const width = info.width, height = info.height;
    if (width < 100 * cols || height < 100 * rows) throw new Error(`Portrait sheet has unusable dimensions ${width}x${height}`);

    const plane = { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
    const gridCells = detectSheetGrid(plane, cols, rows);
    if (!gridCells.detected) {
        opts.onMismatch?.({
            kind: 'no-dividers',
            message: `no divider lines found on the ${cols}x${rows} sheet; using equal split`,
            detail: { width, height, dividers: describeDividers(plane) },
        });
    } else if (gridCells.cols !== cols || gridCells.rows !== rows) {
        // The model drew a different grid than asked. Its cells are still in row-major
        // order, so they are used as drawn; only characters past the last drawn cell
        // fall back to the equal split.
        opts.onMismatch?.({
            kind: 'different-grid',
            message: `sheet drawn as ${gridCells.cols}x${gridCells.rows}, requested ${cols}x${rows}; using the drawn cells`,
            detail: { width, height, drawnCells: gridCells.cells.length, needed: count },
        });
    }
    const fallback = equalSplitGrid(width, height, cols, rows).cells;

    const slices: PortraitSlice[] = [];
    for (let i = 0; i < count; i++) {
        const framing = defaultFraming(gridCells.cells[i] ?? fallback[i]);
        const jpeg = await cutCard(sharp, grid, framing.card);
        slices.push({ key: cells[i].key, label: cells[i].label, jpeg, framing });
    }

    let sheetJpeg: Buffer = await sharp(grid).jpeg({ quality: SHEET_JPEG_QUALITY, mozjpeg: true }).toBuffer();
    if (sheetJpeg.length * 4 / 3 > SHEET_MAX_BASE64_BYTES) {
        sheetJpeg = await sharp(grid).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
    }
    return {
        slices,
        sheet: { jpeg: sheetJpeg, width, height, cells: gridCells.cells.slice(0, count), detected: gridCells.detected },
    };
}

/** Cuts one card out of a stored sheet at the given framing. */
export async function cutCard(sharp: SharpLike, sheet: Buffer, card: ImageRect): Promise<Buffer> {
    return sharp(sheet)
        .extract(card)
        .resize(CARD_WIDTH_PX, CARD_HEIGHT_PX)
        .jpeg({ quality: 85 })
        .toBuffer();
}

export interface DrawPortraitSheetSpec extends Omit<PortraitSheetPrompt, 'cols' | 'rows'> {
    /** Prompt for the cells that pad the cast out to a full grid. */
    fillerPrompt?: string;
}

export interface DrawPortraitSheetOptions extends SliceSheetOptions {
    image?: Pick<GenerateImageOptions, 'model' | 'imageSize' | 'fetchImpl'>;
}

export interface DrawnPortraitSheet {
    portraits: PortraitSlice[];
    sheet: DrawnSheet;
    /** What the image call cost, reported for the host's billing. */
    costUSD: number;
}

/**
 * The whole pipeline: lay the cast out on a grid, draw it in one call, cut the
 * cards. Filler cells are drawn and discarded; `portraits` has exactly one entry
 * per input cell, in order.
 */
export async function drawPortraitSheet(apiKey: string, sharp: SharpLike, spec: DrawPortraitSheetSpec, opts: DrawPortraitSheetOptions = {}): Promise<DrawnPortraitSheet> {
    const { cells, cols, rows, realCount } = padCells(spec.cells, spec.fillerPrompt);
    const prompt = buildPortraitSheetPrompt({ cells, cols, rows, purpose: spec.purpose, setting: spec.setting, artStyle: spec.artStyle });
    const image = await generateImage(apiKey, prompt, '4:3', opts.image);
    const { slices, sheet } = await sliceSheet(sharp, image.buffer, cells, realCount, cols, rows, opts);
    return { portraits: slices, sheet, costUSD: image.costUSD };
}
