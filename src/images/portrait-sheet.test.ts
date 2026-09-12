/**
 * Portrait-sheet pipeline: grid layout, prompt wording the slicer depends on, the
 * slicer over a synthetic sheet through a fake sharp, and the Gemini call's request
 * shape and cost accounting through a fake fetch.
 */
import { buildPortraitSheetPrompt, cutCard, DEFAULT_FILLER_PROMPT, gridFor, padCells, sliceSheet, drawPortraitSheet } from './portrait-sheet';
import { generateImage } from './google-image';
import { calculateImageCost, IMAGE_MODEL_CONSTANTS } from './image-catalog';
import { CARD_HEIGHT_PX, CARD_WIDTH_PX, DEFAULT_AVATAR_CIRCLE, PortraitCell, SharpLike } from './types';

const cell = (i: number): PortraitCell => ({ key: `c${i}`, label: `Char ${i}`, prompt: `(female) "Char ${i}" — a face` });

describe('gridFor / padCells', () => {
    it('picks square-to-portrait grids and never 4x4', () => {
        expect(gridFor(5)).toEqual({ cols: 3, rows: 2 });
        expect(gridFor(8)).toEqual({ cols: 4, rows: 2 });
        expect(gridFor(9)).toEqual({ cols: 3, rows: 3 });
        expect(gridFor(12)).toEqual({ cols: 4, rows: 3 });
        expect(gridFor(15)).toEqual({ cols: 5, rows: 3 });
        expect(gridFor(17)).toEqual({ cols: 6, rows: 3 });
        expect(() => gridFor(19)).toThrow('max 18');
    });

    it('pads the cast to a full grid with fillers and keeps the real count', () => {
        const cast = [cell(1), cell(2), cell(3), cell(4), cell(5), cell(6), cell(7)];
        const { cells, cols, rows, realCount } = padCells(cast);
        expect([cols, rows]).toEqual([4, 2]);
        expect(realCount).toBe(7);
        expect(cells).toHaveLength(8);
        expect(cells[7]).toEqual({ key: '__filler7', label: 'Stranger', prompt: DEFAULT_FILLER_PROMPT });
        expect(padCells(cast, 'an empty chair').cells[7].prompt).toBe('an empty chair');
    });
});

describe('buildPortraitSheetPrompt', () => {
    const base = { cells: [cell(1), cell(2)], cols: 2, rows: 1, purpose: 'a card game', setting: { title: 'Glass Harbor', description: 'Canals and lanterns.' } };

    it('states the grid, the purpose, the setting, row-major cells and the no-text rule', () => {
        const p = buildPortraitSheetPrompt(base);
        expect(p).toContain('A character portrait sheet for a card game');
        expect(p).toContain('exactly 2 rectangular cells, 2 columns and 1 rows');
        expect(p).toContain('separated by thin dark divider lines');
        expect(p).toContain('Setting — "Glass Harbor": Canals and lanterns.');
        expect(p).toContain('Cell 1: (female) "Char 1" — a face. Its own distinct flat solid muted background color.');
        expect(p).toContain('Cell 2:');
        expect(p).toContain('Absolutely no text anywhere in the image');
    });

    it('lets a player art style replace the model\'s own choice', () => {
        expect(buildPortraitSheetPrompt(base)).toContain('Choose ONE cohesive illustration style');
        const styled = buildPortraitSheetPrompt({ ...base, artStyle: 'gouache' });
        expect(styled).toContain('chosen by the player: "gouache"');
        expect(styled).not.toContain('Choose ONE cohesive illustration style');
    });
});

/**
 * A fake sharp over a synthetic greyscale sheet: light cells with dark divider lines.
 * Records every extract so the test can see which cells were cut. Any pipeline
 * returns the same "image" bytes; only the greyscale/raw path yields real pixels.
 */
function fakeSharp(width: number, height: number, rowLines: number[], colLines: number[]): { sharp: SharpLike; extracts: any[]; jpegQualities: number[] } {
    const data = new Uint8Array(width * height).fill(150);
    const paintRow = (y: number) => { for (let x = 0; x < width; x++) data[y * width + x] = 20; };
    const paintCol = (x: number) => { for (let y = 0; y < height; y++) data[y * width + x] = 20; };
    for (const y of rowLines) for (let t = 0; t < 6; t++) paintRow(y + t);
    for (const x of colLines) for (let t = 0; t < 6; t++) paintCol(x + t);
    const extracts: any[] = [];
    const jpegQualities: number[] = [];
    const pipeline = (): any => {
        let rawMode = false;
        const p: any = {
            resize: () => p,
            greyscale: () => p,
            raw: () => { rawMode = true; return p; },
            extract: (rect: any) => { extracts.push(rect); return p; },
            jpeg: (o: any) => { jpegQualities.push(o.quality); return p; },
            metadata: async () => ({ width, height }),
            toBuffer: async (o?: any) => rawMode && o?.resolveWithObject
                ? { data: Buffer.from(data), info: { width, height } }
                : Buffer.from('jpeg-bytes'),
        };
        return p;
    };
    return { sharp: (() => pipeline()) as unknown as SharpLike, extracts, jpegQualities };
}

describe('sliceSheet', () => {
    it('cuts one 3:4 card per real cell off the drawn lines and keeps the sheet', async () => {
        // 4x2 drawn: lines at x=300,600,900 and y=400 on a 1200x800 sheet.
        const { sharp, extracts } = fakeSharp(1200, 800, [400], [300, 600, 900]);
        const cells = padCells([cell(1), cell(2), cell(3), cell(4), cell(5)]).cells; // 3x2 requested
        const mismatches: any[] = [];
        const { slices, sheet } = await sliceSheet(sharp, Buffer.from('raw'), cells, 5, 3, 2, { onMismatch: m => mismatches.push(m) });

        expect(slices).toHaveLength(5);
        expect(slices.map(s => s.key)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
        // Drawn 4x2 differs from the requested 3x2: reported, and the drawn cells are used.
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0].kind).toBe('different-grid');
        expect(sheet.detected).toBe(true);
        expect(sheet.cells).toHaveLength(5);
        expect(sheet.width).toBe(1200);
        // Every card is the framing's card, 3:4, top-anchored in its cell.
        for (const s of slices) {
            expect(s.framing.circle).toEqual(DEFAULT_AVATAR_CIRCLE);
            expect(s.framing.card.width / s.framing.card.height).toBeCloseTo(0.75, 1);
        }
        expect(extracts).toHaveLength(5);
        expect(slices[0].framing.card.top).toBe(4); // divider inset
    });

    it('falls back to the equal split and reports it when no lines are drawn', async () => {
        const { sharp } = fakeSharp(1200, 800, [], []);
        const cells = padCells([cell(1), cell(2), cell(3)]).cells;
        const mismatches: any[] = [];
        const { slices, sheet } = await sliceSheet(sharp, Buffer.from('raw'), cells, 3, 3, 2, { onMismatch: m => mismatches.push(m) });
        expect(mismatches.map(m => m.kind)).toEqual(['no-dividers']);
        expect(sheet.detected).toBe(false);
        expect(slices).toHaveLength(3);
    });

    it('rejects a sheet too small to hold the grid', async () => {
        const { sharp } = fakeSharp(200, 100, [], []);
        await expect(sliceSheet(sharp, Buffer.from('raw'), padCells([cell(1)]).cells, 1, 3, 2)).rejects.toThrow('unusable dimensions');
    });

    it('cutCard extracts the card and resizes to the stored card size', async () => {
        const { sharp, extracts } = fakeSharp(100, 100, [], []);
        const resizeSpy = jest.fn();
        const wrapped = ((buf: Buffer) => { const p: any = sharp(buf); const orig = p.resize; p.resize = (...a: any[]) => { resizeSpy(...a); return orig(...a); }; return p; }) as unknown as SharpLike;
        await cutCard(wrapped, Buffer.from('sheet'), { left: 1, top: 2, width: 30, height: 40 });
        expect(extracts).toEqual([{ left: 1, top: 2, width: 30, height: 40 }]);
        expect(resizeSpy).toHaveBeenCalledWith(CARD_WIDTH_PX, CARD_HEIGHT_PX);
    });
});

describe('generateImage', () => {
    const okResponse = (imageTokens: number, inputTokens: number) => ({
        ok: true,
        status: 200,
        json: async () => ({
            steps: [{ content: [{ type: 'text', text: 'here' }, { type: 'image', data: Buffer.from('png').toString('base64') }] }],
            usage: { total_input_tokens: inputTokens, output_tokens_by_modality: [{ modality: 'image', tokens: imageTokens }, { modality: 'text', tokens: 5 }] },
        }),
        text: async () => '',
    });

    it('sends the prompt, references and format, and prices the result from usage', async () => {
        const fetchImpl = jest.fn(async () => okResponse(1120, 300)) as any;
        const out = await generateImage('key', 'draw it', '4:3', { references: [{ label: 'the hall', jpeg: Buffer.from('ref') }], imageSize: '1K', fetchImpl });

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toContain('/v1beta/interactions');
        expect(init.headers['x-goog-api-key']).toBe('key');
        const body = JSON.parse(init.body);
        expect(body.model).toBe(IMAGE_MODEL_CONSTANTS.GEMINI_FLASH_IMAGE);
        expect(body.input).toEqual([
            { type: 'text', text: 'draw it' },
            { type: 'text', text: 'the hall' },
            { type: 'image', mime_type: 'image/jpeg', data: Buffer.from('ref').toString('base64') },
        ]);
        expect(body.response_format).toEqual({ type: 'image', mime_type: 'image/jpeg', aspect_ratio: '4:3', image_size: '1K' });
        expect(out.buffer.toString()).toBe('png');
        expect(out.costUSD).toBe(calculateImageCost(IMAGE_MODEL_CONSTANTS.GEMINI_FLASH_IMAGE, 1120, 300));
        expect(out.costUSD).toBeCloseTo(0.06735, 5);
    });

    it('surfaces HTTP failures and empty responses', async () => {
        const failing = jest.fn(async () => ({ ok: false, status: 429, text: async () => 'slow down' })) as any;
        await expect(generateImage('key', 'p', '1:1', { fetchImpl: failing })).rejects.toThrow('HTTP 429 slow down');
        const empty = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ steps: [] }), text: async () => '' })) as any;
        await expect(generateImage('key', 'p', '1:1', { fetchImpl: empty })).rejects.toThrow('no image data');
    });
});

describe('drawPortraitSheet', () => {
    it('runs layout, draw and slice end to end and reports the cost', async () => {
        const { sharp } = fakeSharp(1200, 800, [400], [400, 800]); // 3x2 drawn
        const fetchImpl = jest.fn(async () => ({
            ok: true, status: 200, text: async () => '',
            json: async () => ({ steps: [{ content: [{ type: 'image', data: Buffer.from('grid').toString('base64') }] }], usage: { total_input_tokens: 100, output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }] } }),
        })) as any;
        const out = await drawPortraitSheet('key', sharp, {
            purpose: 'a party game',
            setting: { title: 'T', description: 'D' },
            cells: [cell(1), cell(2), cell(3), cell(4)],
        }, { image: { fetchImpl } });
        expect(out.portraits.map(p => p.key)).toEqual(['c1', 'c2', 'c3', 'c4']);
        expect(out.sheet.detected).toBe(true);
        expect(out.costUSD).toBeCloseTo(0.06725, 5);
        const prompt = JSON.parse(fetchImpl.mock.calls[0][1].body).input[0].text;
        expect(prompt).toContain('exactly 6 rectangular cells, 3 columns and 2 rows');
        expect(prompt).toContain('Cell 5: "Stranger"');
    });
});
