import { calculateImageCost, DEFAULT_IMAGE_MODEL, ImageModelId } from './image-catalog';
import { GeneratedImage } from './types';

export type ImageAspectRatio = '1:1' | '3:4' | '4:3' | '3:2' | '2:3' | '16:9' | '9:16';

export interface GenerateImageOptions {
    /** Labeled reference JPEGs (an established scene, character portraits) that
     * anchor the drawing to a known style, place or faces. */
    references?: { label: string; jpeg: Buffer }[];
    imageSize?: '1K' | '2K';
    model?: ImageModelId;
    /** Test seam / custom transport; defaults to the global fetch. */
    fetchImpl?: typeof fetch;
}

/**
 * One image-model call on Gemini's Interactions API. Pure — no auth, no billing —
 * and the result reports its cost so the host decides whom to charge. Cost is per
 * IMAGE, not per pixel (a 1K and a 2K image both bill ~1120 output tokens).
 */
export async function generateImage(apiKey: string, prompt: string, aspectRatio: ImageAspectRatio, opts: GenerateImageOptions = {}): Promise<GeneratedImage> {
    const model = opts.model ?? DEFAULT_IMAGE_MODEL;
    const input: any[] = [{ type: 'text', text: prompt }];
    for (const ref of opts.references ?? []) {
        input.push({ type: 'text', text: ref.label });
        input.push({ type: 'image', mime_type: 'image/jpeg', data: ref.jpeg.toString('base64') });
    }
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
            model,
            input,
            response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: aspectRatio, image_size: opts.imageSize ?? '2K' },
        }),
    });
    if (!res.ok) {
        throw new Error(`Image request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const json: any = await res.json();
    const b64 = (json.steps || [])
        .flatMap((s: any) => s.content || [])
        .find((c: any) => c.type === 'image' && c.data)?.data;
    if (!b64) throw new Error('Image response contained no image data');

    const usage = json.usage || {};
    const imageTokens = (usage.output_tokens_by_modality || [])
        .filter((m: any) => m.modality === 'image')
        .reduce((sum: number, m: any) => sum + (m.tokens || 0), 0);
    const inputTokens = usage.total_input_tokens || 0;

    return { buffer: Buffer.from(b64, 'base64'), costUSD: calculateImageCost(model, imageTokens, inputTokens) };
}
