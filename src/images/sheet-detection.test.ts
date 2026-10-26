/**
 * Portrait-sheet cell detection: the model draws the divider lines where it
 * likes, so the cells are read off the pixels rather than assumed equal.
 */

import { confirmGrid, describeDividers, detectSheetGrid, equalSplitGrid, findDividers, GreyPlane } from './sheet-detection';

/** A synthetic sheet: light cells, near-black divider lines at the given
 * positions (each `thickness` px), plus a 3px border frame. */
function sheet(width: number, height: number, rowLines: number[], colLines: number[], thickness = 6, border = 3): GreyPlane {
    const data = new Uint8Array(width * height).fill(150);
    const paintRow = (y: number) => { for (let x = 0; x < width; x++) data[y * width + x] = 20; };
    const paintCol = (x: number) => { for (let y = 0; y < height; y++) data[y * width + x] = 20; };
    for (let b = 0; b < border; b++) { paintRow(b); paintRow(height - 1 - b); paintCol(b); paintCol(width - 1 - b); }
    for (const y of rowLines) for (let t = 0; t < thickness; t++) paintRow(y + t);
    for (const x of colLines) for (let t = 0; t < thickness; t++) paintCol(x + t);
    return { width, height, data };
}

describe('findDividers', () => {
    it('reports internal lines and ignores the border frame', () => {
        const plane = sheet(400, 300, [140], [100, 200, 300]);
        const d = findDividers(plane);
        expect(d.rows).toEqual([{ start: 140, end: 145 }]);
        expect(d.cols.map(c => c.start)).toEqual([100, 200, 300]);
    });

    it('ignores a dark band far thicker than a line (a dark art style, not a boundary)', () => {
        const plane = sheet(400, 300, [140], [100, 200, 300]);
        for (let y = 200; y < 260; y++) for (let x = 0; x < 400; x++) plane.data[y * 400 + x] = 15;
        expect(findDividers(plane).rows).toEqual([{ start: 140, end: 145 }]);
    });

    it('treats a dark name plate hugging a line as part of the boundary', () => {
        const plane = sheet(400, 400, [200], [100, 200, 300]);
        for (let y = 180; y < 200; y++) for (let x = 0; x < 400; x++) plane.data[y * 400 + x] = 15; // plate above the line
        const grid = detectSheetGrid(plane, 4, 2);
        expect(findDividers(plane).rows).toEqual([{ start: 180, end: 205 }]);
        expect(grid.cells[0].top + grid.cells[0].height).toBeLessThanOrEqual(180);
    });

    it('does not take a dark portrait for a line', () => {
        const plane = sheet(400, 300, [], []);
        // A dark 60%-wide band: clothing across most of a row, never a divider.
        for (let x = 0; x < 240; x++) plane.data[150 * 400 + x] = 10;
        expect(findDividers(plane).rows).toEqual([]);
    });

    // Nano Banana 2.1 (2026-10-21) paints "muted" backgrounds at 40-58 on the
    // grey plane: whole cells pass the darkness test, so a line fused into a
    // dark cell was dropped as too thick and dark objects passed as lines.
    describe('dark cell backgrounds', () => {
        function darkSheet(): GreyPlane {
            const plane = sheet(600, 300, [], [200, 400]);
            // Cells 2 and 3 (x 206-399, 406-599) have a navy background just under the threshold.
            for (let y = 0; y < 300; y++) for (let x = 206; x < 600; x++) if (plane.data[y * 600 + x] === 150) plane.data[y * 600 + x] = 55;
            return plane;
        }

        it('still finds a line between two dark cells', () => {
            // Two dark cells either side of the line at 400: the darkness test sees one
            // 400 px run and drops it as too thick; the contrast test keeps the line.
            expect(findDividers(darkSheet()).cols.map(c => c.start)).toEqual([200, 400]);
        });

        it('does not take a dark object standing in a dark cell for a line', () => {
            const plane = darkSheet();
            // A walking stick: 10 px wide, 25 on the plane, the lower 60% of the cell.
            for (let y = 120; y < 300; y++) for (let x = 300; x < 310; x++) plane.data[y * 600 + x] = 25;
            // A patch of even darker background taller than the cell: no contrast with its flanks.
            for (let y = 0; y < 300; y++) for (let x = 450; x < 500; x++) plane.data[y * 600 + x] = 38;
            expect(findDividers(plane).cols.map(c => c.start)).toEqual([200, 400]);
        });

        it('keeps a faint line when its flanks are only a little lighter', () => {
            const plane = sheet(400, 300, [], [200], 8);
            for (let i = 0; i < plane.data.length; i++) if (plane.data[i] === 150) plane.data[i] = 70;
            for (let y = 0; y < 300; y++) for (let x = 200; x < 208; x++) plane.data[y * 400 + x] = 29;
            expect(findDividers(plane).cols).toEqual([{ start: 200, end: 207 }]);
        });

        it('confirms the requested grid on a dark art style where lines barely contrast', () => {
            // A space station: backgrounds at 40, lines at 2, a dark strip at 35 along
            // the top of every row-1 cell (the cell's own content, not the line).
            const plane = sheet(1000, 600, [200, 400], [200, 400, 600, 800], 6);
            for (let i = 0; i < plane.data.length; i++) if (plane.data[i] === 150) plane.data[i] = 40;
            for (let i = 0; i < plane.data.length; i++) if (plane.data[i] === 20) plane.data[i] = 2;
            for (let y = 206; y < 260; y++) for (let x = 0; x < 1000; x++) if (plane.data[y * 1000 + x] === 40) plane.data[y * 1000 + x] = 35;
            const grid = detectSheetGrid(plane, 5, 3);
            expect(grid.detected).toBe(true);
            expect(grid.cols).toBe(5);
            expect(grid.rows).toBe(3);
            expect(grid.cells).toHaveLength(15);
            // The row-1 cells start right under the line, not under the dark strip.
            expect(grid.cells[5].top).toBe(210);
            expect(grid.cells[6].left).toBe(210);
        });

        it('does not confirm a faint sketchy line that barely contrasts with its cells', () => {
            // A broken grey line at 50 (80% of its length) between cells at 65: under the
            // full share, and only 12 darker than the cells — not a boundary.
            const plane = sheet(1000, 600, [200, 400], [200, 400, 600, 800], 3);
            breakLines(plane, 5);
            for (let i = 0; i < plane.data.length; i++) if (plane.data[i] === 150) plane.data[i] = 65;
            for (let i = 0; i < plane.data.length; i++) if (plane.data[i] === 20) plane.data[i] = 50;
            expect(confirmGrid(plane, 5, 3)).toBeNull();
        });

        it('keeps a row line with dark shoulders above it', () => {
            // The previous row's clothing reaches the line across 70% of the width;
            // the next row's headroom below it is clear.
            const plane = sheet(400, 400, [200], []);
            for (let y = 150; y < 200; y++) for (let x = 60; x < 340; x++) plane.data[y * 400 + x] = 30;
            expect(findDividers(plane).rows).toEqual([{ start: 200, end: 205 }]);
        });
    });
});

/** Every `every`-th pixel of a line pixel (value `line`) becomes the
 * background: a sketchy ink stroke that covers only part of its length. */
function breakLines(plane: GreyPlane, every: number, line = 20, background = 150): void {
    const {width, height, data} = plane;
    for (let y = 3; y < height - 3; y++) for (let x = 3; x < width - 3; x++) {
        if (data[y * width + x] !== line) continue;
        if ((x + y) % every === 0) data[y * width + x] = background;
    }
}

describe('confirmGrid with sketchy ink lines (Nano Banana 2.1, 2026-10-25)', () => {
    it('confirms a grid whose thin broken lines cover only 80% of their length', () => {
        // 3 px lines with every fifth pixel missing: dark share 0.8, under
        // GRID_LINE_SHARE. Backgrounds at 150 make them stand out.
        const plane = sheet(1000, 600, [200, 400], [200, 400, 600, 800], 3);
        breakLines(plane, 5);
        const grid = confirmGrid(plane, 5, 3);
        expect(grid).not.toBeNull();
        expect(grid!.cells).toHaveLength(15);
        expect(grid!.cells[1].left).toBe(207);
        expect(grid!.cells[5].top).toBe(207);
    });

    it('confirms a grid of thin ink borders along paper gutters', () => {
        // 2 px broken ink lines on both sides of a 12 px bright gutter (230) between
        // muted cells (120): the treasure-island sheet.
        const plane = sheet(1000, 600, [], [], 0);
        for (let i = 0; i < plane.data.length; i++) if (plane.data[i] === 150) plane.data[i] = 120;
        const paint = (axis: 'rows' | 'cols', at: number, thickness: number, value: number) => {
            for (let t = 0; t < thickness; t++) for (let k = 3; k < (axis === 'rows' ? 1000 : 600) - 3; k++) {
                const idx = axis === 'rows' ? (at + t) * 1000 + k : k * 1000 + at + t;
                plane.data[idx] = value;
            }
        };
        for (const x of [194, 394, 594, 794]) { paint('cols', x, 2, 20); paint('cols', x + 2, 12, 230); paint('cols', x + 14, 2, 20); }
        for (const y of [194, 394]) { paint('rows', y, 2, 20); paint('rows', y + 2, 12, 230); paint('rows', y + 14, 2, 20); }
        breakLines(plane, 6);
        const grid = confirmGrid(plane, 5, 3);
        expect(grid).not.toBeNull();
        expect(grid!.cells).toHaveLength(15);
        // The cells sit inside the ink, whichever stroke the confirmation picked.
        expect(grid!.cells[1].left).toBeGreaterThanOrEqual(198);
        expect(grid!.cells[1].left).toBeLessThanOrEqual(214);
    });

    it('still ignores a sketchy line that is too faint to count at all', () => {
        const plane = sheet(1000, 600, [200, 400], [200, 400, 600, 800], 3);
        breakLines(plane, 2); // half the pixels gone: share 0.5
        expect(confirmGrid(plane, 5, 3)).toBeNull();
    });
});

describe('detectSheetGrid', () => {
    it('uses the drawn lines when they match the request — drifting rows included', () => {
        // Rows 0-140, 146-270, 276-400: unequal, as the model really draws them.
        const plane = sheet(400, 400, [140, 270], [100, 200, 300]);
        const grid = detectSheetGrid(plane, 4, 3);
        expect(grid.detected).toBe(true);
        expect(grid.cells).toHaveLength(12);
        // Second row, first column: between the first line's end and the
        // second line's start, inset by the anti-alias margin.
        expect(grid.cells[4]).toEqual({ left: 4, top: 150, width: 92, height: 116 });
        // Last row runs to the bottom edge.
        expect(grid.cells[8].top + grid.cells[8].height).toBe(396);
    });

    it('uses the drawn grid even when it is not the one requested', () => {
        const plane = sheet(600, 400, [200], [100, 200, 300, 400, 500]); // 6x2 drawn, 4x4 asked
        const grid = detectSheetGrid(plane, 4, 4);
        expect(grid.detected).toBe(true);
        expect(grid.cols).toBe(6);
        expect(grid.rows).toBe(2);
        expect(grid.cells).toHaveLength(12);
        expect(describeDividers(plane)).toContain('rows@200-205');
    });

    it('falls back to the equal split when no column lines are found', () => {
        const plane = sheet(400, 400, [200], []);
        const grid = detectSheetGrid(plane, 4, 4);
        expect(grid.detected).toBe(false);
        expect(grid.cells).toEqual(equalSplitGrid(400, 400, 4, 4).cells);
    });

    it('ignores lines that would leave a sliver instead of a cell', () => {
        const plane = sheet(400, 300, [10, 30], [100, 200, 300]);
        const grid = detectSheetGrid(plane, 4, 3);
        expect(grid.detected).toBe(true);
        expect(grid.rows).toBe(1);
        expect(grid.cells).toHaveLength(4);
    });

    it('ignores hairline specks thinner than a drawn line', () => {
        const plane = sheet(400, 400, [200], [100, 200, 300], 6);
        for (let x = 0; x < 400; x++) plane.data[300 * 400 + x] = 10; // one dark pixel row
        expect(findDividers(plane).rows).toEqual([{ start: 200, end: 205 }]);
    });

    it('reads column lines per row band, so rows may differ', () => {
        // Top band: 2 columns (line at 200). Bottom band: 4 columns.
        const plane = sheet(400, 400, [200], []);
        for (let y = 0; y < 200; y++) for (let t = 0; t < 6; t++) plane.data[y * 400 + 200 + t] = 20;
        for (let y = 206; y < 400; y++) for (const x of [100, 200, 300]) for (let t = 0; t < 6; t++) plane.data[y * 400 + x + t] = 20;
        const grid = detectSheetGrid(plane, 4, 2);
        expect(grid.detected).toBe(true);
        expect(grid.cells).toHaveLength(6);
        expect(grid.cells[0].width).toBeGreaterThan(150);
        expect(grid.cells[2].width).toBeLessThan(100);
    });

    it('lets a band without lines borrow the layout above it', () => {
        const plane = sheet(400, 400, [200], []);
        for (let y = 0; y < 200; y++) for (let t = 0; t < 6; t++) plane.data[y * 400 + 200 + t] = 20;
        const grid = detectSheetGrid(plane, 2, 2);
        expect(grid.cells).toHaveLength(4);
    });
});

describe('equalSplitGrid', () => {
    it('insets each cell from the assumed divider by 8px', () => {
        const grid = equalSplitGrid(800, 600, 4, 3);
        expect(grid.cells[0]).toEqual({ left: 8, top: 8, width: 184, height: 184 });
        expect(grid.cells[11]).toEqual({ left: 608, top: 408, width: 184, height: 184 });
    });
});
