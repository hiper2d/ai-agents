import { ImageRect } from "./types";

/**
 * Finds the cells of a drawn portrait sheet from its pixels.
 *
 * The prompt asks for equal cells separated by thin dark divider lines, but
 * the model draws the lines where it likes: on a correctly drawn 4x4 sheet
 * the rows measured 497 / 485 / 428 / 382 px where equal splits assumed 448
 * (2026-09-02), so fixed-interval slicing cut lower rows through the previous
 * character's chest. The lines themselves are crisp — near-black across the
 * full width — so they are easy to find, and the cells between them are the
 * real ones. Columns have always measured exact; rows drift.
 *
 * Pure over a greyscale byte plane so it is testable without sharp.
 */

export interface GreyPlane {
    width: number;
    height: number;
    // width*height bytes, row-major, 0 = black.
    data: Uint8Array;
}

export interface SheetGrid {
    cells: ImageRect[]; // row-major
    cols: number;
    rows: number;
    // false = no usable divider lines were found and this is the equal split
    // of the REQUESTED grid. true = the cells between the lines the model
    // actually drew, which may be a different grid than requested (a 4x4
    // request has come back as 4x3 and as 6x3) — the sheet is the truth.
    detected: boolean;
}

// A pixel darker than this is "line"; a scanline with more than this share
// of dark pixels is a divider. Cell backgrounds are flat muted colours, well
// above the threshold, and the dark portrait clothing never spans a full line.
const DARK_MAX = 60;
const DIVIDER_SHARE = 0.85;
// Darkness alone stopped being enough with Nano Banana 2.1 (2026-10-21): its
// "muted" backgrounds measured 40-58 on the grey plane, so whole cells read as
// dark and a 4x3 sheet came back as 5x3 with the cast cut through the seams
// (a divider at x=1800 was swallowed by a 200 px dark run and dropped as too
// thick, while a walking stick and two patches of navy background passed as
// lines). A line pixel must therefore also be darker than BOTH flanks of its
// scanline — the mean over a window this far out on each side, outside any
// line (lines are ≤ ~9 px) — by at least LINE_CONTRAST. Lines are near-black
// (0-30), backgrounds ≥ 40 right next to them; a dark object inside a cell
// (stick, hair, hood edge) has a dark flank on at least one side.
const LINE_CONTRAST = 20;
const FLANK_FROM = 6;
const FLANK_TO = 15;
// The contrast test fails the other way on a dark art style (a space station,
// a polar night, 2026-10-21): lines of 1-30 between backgrounds of 30-50 are
// not 20 darker than their flanks, and a 5x3 sheet read as 2x1. So the
// requested grid is tried FIRST: the model draws equal cells, and when every
// equal-split position has a dark line within this share of the cell pitch,
// those lines are the grid — no contrast needed. Only a sheet that fails
// that check goes through the general line search below.
const GRID_LINE_TOLERANCE = 0.08;
const GRID_LINE_SHARE = 0.9;
// A scanline next to a confirmed line belongs to it only when its mean is
// within this of the line's: a name plate (15 vs a 20 line) does, the dark
// top of a space-station cell (40 vs a 2 line) does not.
const LINE_MEAN_MARGIN = 15;
// Pixels kept clear of a divider when cutting (anti-aliased edges).
const DIVIDER_INSET = 4;
// A real divider is a thin line (~7 px on a 2400 px sheet). Thinner runs are
// specks (a dark hairline inside a hooded figure once passed as a row line).
// Thicker runs up to a small share of the sheet are still boundaries: the
// model sometimes adds a dark name plate under each portrait despite the
// no-text rule, and the plate belongs OUTSIDE the cell. Beyond that share a
// dark run is a dark art style's background, not a boundary.
const DIVIDER_MIN_THICKNESS = 3;
const DIVIDER_MAX_THICKNESS_SHARE = 0.08;
// A span between lines narrower than this share of the sheet can't hold a
// face; the line that would create it is not a cell boundary.
const MIN_SPAN_SHARE = 0.12;

interface Run { start: number; end: number }

function runs(indices: number[]): Run[] {
    const out: Run[] = [];
    for (const i of indices) {
        const last = out[out.length - 1];
        if (last && i === last.end + 1) last.end = i;
        else out.push({start: i, end: i});
    }
    return out;
}

/** Divider runs along one axis, measured over a window of the other axis (a
 * band of rows for columns, the full height by default). Border runs and
 * runs that aren't line-shaped are dropped.
 *
 * Two readings are merged. Dark runs (every scanline mostly below DARK_MAX)
 * are kept when the run as a whole stands out from the plane just outside it
 * — that is the thin line, and the line with a name plate hugging it. Thin
 * contrast runs (scanlines darker than both their flanks at a fixed distance)
 * find a line that a dark background or a dark cast has fused into one run
 * too thick to be a boundary. */
function lineRuns(plane: GreyPlane, axis: 'rows' | 'cols', from: number, to: number): Run[] {
    const {width, height, data} = plane;
    const extent = axis === 'rows' ? height : width;
    const span = to - from;
    // Pixel k of scanline i (k runs across the window, i along the axis).
    const at = axis === 'rows'
        ? (i: number, k: number) => data[i * width + k]
        : (i: number, k: number) => data[k * width + i];
    const clamp = (i: number) => Math.min(extent - 1, Math.max(0, i));
    const flankMean = (i: number, k: number, dir: -1 | 1, start: number, end: number): number => {
        let sum = 0;
        for (let d = start; d <= end; d++) sum += at(clamp(i + dir * d), k);
        return sum / (end - start + 1);
    };
    const maxThickness = extent * DIVIDER_MAX_THICKNESS_SHARE;
    const lineShaped = (r: Run) => {
        const t = r.end - r.start + 1;
        return r.start > 2 && r.end < extent - 3 && t >= DIVIDER_MIN_THICKNESS && t <= maxThickness;
    };

    const dark: number[] = [];
    const contrast: number[] = [];
    for (let i = 0; i < extent; i++) {
        let darkCount = 0, contrastCount = 0;
        for (let k = from; k < to; k++) {
            const v = at(i, k);
            if (v >= DARK_MAX) continue;
            darkCount++;
            const flank = Math.min(flankMean(i, k, -1, FLANK_FROM, FLANK_TO), flankMean(i, k, 1, FLANK_FROM, FLANK_TO));
            if (v < flank - LINE_CONTRAST) contrastCount++;
        }
        if (darkCount / span > DIVIDER_SHARE) dark.push(i);
        if (contrastCount / span > DIVIDER_SHARE) contrast.push(i);
    }

    // Dark runs that stand out from what lies just outside them: the run's
    // mean across its scanlines (a soft stroke has no single dark centre)
    // against the flanks beyond either end. The brighter flank decides: a row
    // line has the previous row's shoulders (often dark clothing) right above
    // it, and the next row's headroom below — measured 0.54-0.82 of the width
    // against the darker flank, 0.98+ against the brighter; the false runs
    // (stick, background patch, hood) reach 0.69.
    const standsOut = (r: Run) => {
        const thickness = r.end - r.start + 1;
        const before = r.start - 1, after = r.end + 1;
        let count = 0;
        for (let k = from; k < to; k++) {
            let sum = 0;
            for (let i = r.start; i <= r.end; i++) sum += at(i, k);
            const flank = Math.max(flankMean(before, k, -1, FLANK_FROM - 1, FLANK_TO - 1), flankMean(after, k, 1, FLANK_FROM - 1, FLANK_TO - 1));
            if (sum / thickness < flank - LINE_CONTRAST) count++;
        }
        return count / span > DIVIDER_SHARE;
    };
    const kept = runs(dark).filter(lineShaped).filter(standsOut);

    // Contrast runs, added where no kept run already covers them. They are not
    // widened over neighbouring dark scanlines: with a dark background that
    // would push the cut into the cell, and the inset already clears the
    // stroke's anti-aliased edge.
    for (const seed of runs(contrast).filter(lineShaped)) {
        if (kept.some(k => k.start <= seed.end && seed.start <= k.end)) continue;
        kept.push(seed);
    }
    return kept.sort((a, b) => a.start - b.start);
}

/** Lines that would leave a sliver on either side are not boundaries. */
function dropSliverMakers(lines: Run[], extent: number): Run[] {
    const minSpan = extent * MIN_SPAN_SHARE;
    const kept: Run[] = [];
    let cursor = 0;
    for (const line of lines) {
        if (line.start - cursor < minSpan || extent - (line.end + 1) < minSpan) continue;
        kept.push(line);
        cursor = line.end + 1;
    }
    return kept;
}

/** Divider runs across the whole plane: row lines over the full width,
 * column lines over the full height. */
export function findDividers(plane: GreyPlane): {rows: Run[]; cols: Run[]} {
    return {
        rows: dropSliverMakers(lineRuns(plane, 'rows', 0, plane.width), plane.height),
        cols: dropSliverMakers(lineRuns(plane, 'cols', 0, plane.height), plane.width),
    };
}

/** Cells between dividers along one axis, from the border to the first line,
 * line to line, last line to the border. */
function spans(dividers: Run[], extent: number): {start: number; end: number}[] {
    const out: {start: number; end: number}[] = [];
    let cursor = 0;
    for (const d of dividers) {
        out.push({start: cursor, end: d.start});
        cursor = d.end + 1;
    }
    out.push({start: cursor, end: extent});
    return out;
}

export function equalSplitGrid(width: number, height: number, cols: number, rows: number): SheetGrid {
    const cellW = Math.floor(width / cols), cellH = Math.floor(height / rows);
    const cells: ImageRect[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            cells.push(inset({left: c * cellW, top: r * cellH, width: cellW, height: cellH}, 8));
        }
    }
    return {cells, cols, rows, detected: false};
}

function inset(rect: ImageRect, by: number): ImageRect {
    return {left: rect.left + by, top: rect.top + by, width: Math.max(1, rect.width - 2 * by), height: Math.max(1, rect.height - 2 * by)};
}

interface Scanlines { shares: Float32Array; means: Float32Array }

/** Per scanline along one axis, over the full extent of the other: the share
 * of dark pixels and the mean value. */
function scanlines(plane: GreyPlane, axis: 'rows' | 'cols'): Scanlines {
    const {width, height, data} = plane;
    const extent = axis === 'rows' ? height : width;
    const span = axis === 'rows' ? width : height;
    const shares = new Float32Array(extent), means = new Float32Array(extent);
    for (let i = 0; i < extent; i++) {
        let count = 0, sum = 0;
        if (axis === 'rows') {
            const base = i * width;
            for (let x = 0; x < width; x++) { const v = data[base + x]; sum += v; if (v < DARK_MAX) count++; }
        } else {
            for (let y = 0; y < height; y++) { const v = data[y * width + i]; sum += v; if (v < DARK_MAX) count++; }
        }
        shares[i] = count / span;
        means[i] = sum / span;
    }
    return {shares, means};
}

/** The dark line nearest an expected position, within the tolerance, or
 * null. The run is the darkest scanline plus its neighbours that are as
 * dark as it, near enough — the stroke and a name plate hugging it, not the
 * dark cell top beside it. Where even that is too thick to be a line (a
 * black art style all around) the line is a 7 px stroke at the darkest
 * scanline. */
function lineNear(lines: Scanlines, position: number, tolerance: number, maxThickness: number): Run | null {
    const {shares, means} = lines;
    const extent = shares.length;
    const lo = Math.max(3, Math.round(position - tolerance));
    const hi = Math.min(extent - 4, Math.round(position + tolerance));
    let at = -1;
    for (let i = lo; i <= hi; i++) if (at < 0 || shares[i] > shares[at] || (shares[i] === shares[at] && means[i] < means[at])) at = i;
    if (at < 0 || shares[at] < GRID_LINE_SHARE) return null;
    const partOfLine = (i: number) => shares[i] >= GRID_LINE_SHARE && means[i] <= means[at] + LINE_MEAN_MARGIN;
    let start = at, end = at;
    while (start - 1 >= 3 && partOfLine(start - 1)) start--;
    while (end + 1 <= extent - 4 && partOfLine(end + 1)) end++;
    if (end - start + 1 > maxThickness) return {start: Math.max(3, at - 3), end: Math.min(extent - 4, at + 3)};
    return {start, end};
}

/** The requested grid confirmed on the pixels: a dark line near every
 * equal-split position on both axes. Null when any line is missing. */
export function confirmGrid(plane: GreyPlane, cols: number, rows: number): SheetGrid | null {
    const {width, height} = plane;
    const find = (axis: 'rows' | 'cols', count: number): Run[] | null => {
        const extent = axis === 'rows' ? height : width;
        const scan = scanlines(plane, axis);
        const pitch = extent / count;
        const lines: Run[] = [];
        for (let k = 1; k < count; k++) {
            const line = lineNear(scan, k * pitch, pitch * GRID_LINE_TOLERANCE, extent * DIVIDER_MAX_THICKNESS_SHARE);
            if (!line) return null;
            lines.push(line);
        }
        return lines;
    };
    const colLines = find('cols', cols);
    if (!colLines) return null;
    const rowLines = find('rows', rows);
    if (!rowLines) return null;
    const cells: ImageRect[] = [];
    for (const band of spans(rowLines, height)) {
        for (const x of spans(colLines, width)) {
            cells.push(inset({left: x.start, top: band.start, width: x.end - x.start, height: band.end - band.start}, DIVIDER_INSET));
        }
    }
    return {cells, cols, rows, detected: true};
}

/**
 * The sheet's cells. The requested grid is confirmed on the pixels first
 * (`confirmGrid`); the model draws it as asked far more often than not, and
 * that check needs no assumptions about the art style. Otherwise the divider
 * lines the model drew are read wherever they form a plausible grid, even
 * when that grid differs from the cols x rows that were asked for — the
 * model keeps row-major order, so the drawn cells still map to the
 * characters in sequence. Row lines are found over the full width; column
 * lines are found PER ROW BAND, because the model has drawn rows with
 * different column layouts (and a column line that stops short of the last
 * row). A band without lines of its own borrows the layout of the band
 * above it. The equal split of the requested grid is the last resort when
 * no lines are found at all (the caller logs it; the kept sheet lets the
 * owner reframe by hand either way).
 */
export function detectSheetGrid(plane: GreyPlane, cols: number, rows: number): SheetGrid {
    const confirmed = confirmGrid(plane, cols, rows);
    if (confirmed) return confirmed;
    const {width, height} = plane;
    const rowLines = dropSliverMakers(lineRuns(plane, 'rows', 0, width), height);
    const bands = spans(rowLines, height);
    const cells: ImageRect[] = [];
    let previous: Run[] | null = null;
    let colCount = 0;
    for (const band of bands) {
        let colLines = dropSliverMakers(lineRuns(plane, 'cols', band.start, band.end), width);
        if (colLines.length === 0 && previous) colLines = previous;
        previous = colLines;
        const xs = spans(colLines, width);
        colCount = Math.max(colCount, xs.length);
        for (const x of xs) {
            cells.push(inset({left: x.start, top: band.start, width: x.end - x.start, height: band.end - band.start}, DIVIDER_INSET));
        }
    }
    if (colCount < 2) return equalSplitGrid(width, height, cols, rows);
    return {cells, cols: colCount, rows: bands.length, detected: true};
}

/** What findDividers saw, for the mismatch log line. */
export function describeDividers(plane: GreyPlane): string {
    const d = findDividers(plane);
    const fmt = (r: Run[]) => r.map(x => `${x.start}-${x.end}`).join(',') || 'none';
    return `rows@${fmt(d.rows)} cols@${fmt(d.cols)}`;
}
