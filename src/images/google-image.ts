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
 * Gemini's Interactions API answers a blocked image with HTTP 200, no image block,
 * `status: "failed"` (or `incomplete`) and an `errors[]` entry whose `code` names the
 * block (https://ai.google.dev/gemini-api/docs/api-errors, "Generation blocked"):
 * `image_safety`, `image_prohibited_content`, `image_recitation`, `image_other`, plus
 * the text-side codes `safety`, `prohibited_content`, `recitation`, `blocklist`, `spii`,
 * `content_blocked`. `no_image` is a plain generation failure, not a block.
 *
 * Deliberately NOT a `ModelRefusalError` subclass: this subpath is bundled apart from the
 * main entry, so an `instanceof` against the main entry's class would never match. Hosts
 * check `isImageRefusalError(error)` (by name) instead. Not retryable on the same prompt.
 */
export class ImageRefusalError extends Error {
    /** The block code as Gemini sent it (a URI or bare `snake_case` name). */
    public code: string;
    /** Gemini's human-readable message, when it sent one. */
    public reason?: string;
    public model: string;

    constructor(model: string, code: string, reason?: string) {
        super(`${model} declined to draw the image (${describeBlockCode(code)})${reason ? `: ${reason}` : ''}`);
        this.name = 'ImageRefusalError';
        this.model = model;
        this.code = code;
        this.reason = reason;
    }
}

/** Works across bundle copies and serialization boundaries (checks the name, not the class). */
export function isImageRefusalError(error: unknown): error is ImageRefusalError {
    return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'ImageRefusalError';
}

const BLOCK_CODE_MARKERS = ['safety', 'prohibited', 'recitation', 'blocklist', 'spii', 'content_blocked', 'image_other'];

/** The trailing identifier of a code URI such as `https://…/api-errors#image_safety`. */
function describeBlockCode(code: string): string {
    const tail = code.split(/[#/]/).filter(Boolean).pop() ?? code;
    return tail.toLowerCase();
}

function isBlockCode(code: string): boolean {
    const tail = describeBlockCode(code);
    return BLOCK_CODE_MARKERS.some(marker => tail.includes(marker));
}

/**
 * One image-model call on Gemini's Interactions API. Pure — no auth, no billing —
 * and the result reports its cost so the host decides whom to charge. Cost is per
 * IMAGE, not per pixel (a 1K and a 2K image both bill ~1120 output tokens).
 *
 * Throws `ImageRefusalError` when Gemini blocked the drawing (see the class), and a
 * plain `Error` naming Gemini's status and error code for any other imageless reply.
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
    if (!b64) throw imagelessReplyError(model, json);

    const usage = json.usage || {};
    const imageTokens = (usage.output_tokens_by_modality || [])
        .filter((m: any) => m.modality === 'image')
        .reduce((sum: number, m: any) => sum + (m.tokens || 0), 0);
    const inputTokens = usage.total_input_tokens || 0;

    return { buffer: Buffer.from(b64, 'base64'), costUSD: calculateImageCost(model, imageTokens, inputTokens) };
}

/** Classifies an HTTP 200 reply that carried no image block. */
function imagelessReplyError(model: string, json: any): Error {
    const errors: { code?: unknown; message?: unknown }[] = Array.isArray(json?.errors) ? json.errors : [];
    const codes = errors.map(e => String(e?.code ?? '')).filter(Boolean);
    const messages = errors.map(e => (typeof e?.message === 'string' ? e.message.trim() : '')).filter(Boolean);
    const block = codes.find(isBlockCode);
    if (block) {
        return new ImageRefusalError(model, block, messages[0]?.slice(0, 300));
    }
    const status = typeof json?.status === 'string' ? json.status : 'unknown';
    const detail = [codes.length ? `code ${codes.map(describeBlockCode).join(', ')}` : '', messages[0]?.slice(0, 300) ?? '']
        .filter(Boolean)
        .join(': ');
    return new Error(`Image response contained no image data (status ${status}${detail ? `; ${detail}` : ''})`);
}
