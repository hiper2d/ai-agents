import { GoogleGenAI } from '@google/genai';
import { VOICE_MODEL_CONSTANTS } from './voice-catalog';

export interface GoogleTtsAudioOptions {
    /** e.g. "Kore", "Puck" */
    voiceName: string;
    /** "mysteriously", "excitedly", or a longer direction; sent as speechMetadata.style */
    voiceStyle?: string;
}

export interface GoogleTtsResult {
    /** WAV, 24 kHz mono 16-bit */
    audio: ArrayBuffer;
    /** text prompt tokens / audio tokens — what Gemini bills */
    usage: { inputTokens: number; outputTokens: number };
    /** True when the styled request was safety-blocked and the line was read without its style. */
    styleDropped?: boolean;
}

// Gemini reports ~32 audio tokens per second of speech (measured 2026-09-05 on
// 3.1 and 2026-09-24 on 3.8 Flash-Lite: 560 tokens for 17.6 s). Used only when a
// response carries no usage.
const AUDIO_TOKENS_PER_SECOND = 32;
const SAMPLE_RATE = 24000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2;
const WAV_HEADER_BYTES = 44;

/**
 * Gemini 3.8 TTS reads the part text as a verbatim transcript: an inline
 * "Say cheerfully:" prefix (the 3.1 convention) may be spoken aloud. Delivery
 * direction goes in the part's `speechMetadata.style` instead, short adverb or
 * longer sentence alike. Trailing punctuation is trimmed; blank means none.
 */
export function normalizeTtsStyle(voiceStyle?: string): string | undefined {
    const style = voiceStyle?.trim().replace(/[:.!,;\s]+$/, '');
    return style || undefined;
}

/** Wraps raw 16-bit mono PCM in a WAV header. */
export function pcmToWav(pcmData: Uint8Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = numChannels * (bitsPerSample / 8);
    const byteRate = sampleRate * blockAlign;
    const headerSize = 44;
    const buffer = new ArrayBuffer(headerSize + pcmData.length);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + pcmData.length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, pcmData.length, true);
    new Uint8Array(buffer, headerSize).set(pcmData);
    return buffer;
}

/**
 * Why a 200 came back without audio. Gemini occasionally returns an empty candidate
 * (a transient `OTHER` / `RECITATION` finish, a safety block reported in
 * promptFeedback, or a text part instead of audio); naming it in the error is the
 * difference between a diagnosable log line and "no audio data".
 */
export function describeEmptyTtsResponse(response: any): string {
    const candidate = response?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];
    const bits: string[] = [];
    bits.push(`finishReason=${candidate?.finishReason ?? 'none'}`);
    if (!response?.candidates?.length) bits.push('no candidates');
    const block = response?.promptFeedback?.blockReason;
    if (block) bits.push(`blockReason=${block}`);
    const text = parts.map(p => typeof p?.text === 'string' ? p.text : '').join(' ').trim();
    if (text) bits.push(`text="${text.slice(0, 120)}"`);
    const otherMimes = parts.map(p => p?.inlineData?.mimeType).filter(Boolean);
    if (otherMimes.length) bits.push(`inlineData=${otherMimes.join(',')}`);
    if (!parts.length) bits.push('no parts');
    return bits.join(', ');
}

/**
 * A safety block on the prompt or the candidate. The 3.1 preview model
 * false-positived on volume directions ("Say quietly: <harmless line>" blocked
 * 4 of 6 on 2026-09-24); 3.8 Flash-Lite with the style in speechMetadata passed
 * the same lines 9 of 9, but the fallback below stays as a net.
 */
export function isSafetyBlocked(response: any): boolean {
    const finish = response?.candidates?.[0]?.finishReason;
    return finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || !!response?.promptFeedback?.blockReason;
}

function findAudioPart(response: any): { data: string; mimeType: string } | undefined {
    const parts: any[] = response?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find(part => part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData?.data)?.inlineData;
    return inline ? { data: inline.data, mimeType: inline.mimeType } : undefined;
}

/**
 * Core Gemini TTS call: text + API key in, WAV + token usage out.
 *
 * 3.8 TTS returns WAV with a RIFF header by default (3.1 returned headerless
 * audio/l16); raw PCM is still wrapped if a response ever carries it.
 *
 * When a styled request comes back safety-blocked, the line is read once more
 * without the style: a block on the direction should not silence the line. An
 * unstyled block is not repeated.
 */
export async function generateGoogleTtsAudio(
    text: string,
    apiKey: string,
    options: GoogleTtsAudioOptions
): Promise<GoogleTtsResult> {
    const client = new GoogleGenAI({ apiKey });
    const request = (style?: string) => client.models.generateContent({
        model: VOICE_MODEL_CONSTANTS.GOOGLE_TTS,
        contents: [{ parts: [style ? { text, speechMetadata: { style } } : { text }] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } } },
        },
    }) as Promise<any>;

    const style = normalizeTtsStyle(options.voiceStyle);
    let response = await request(style);
    let styleDropped = false;
    // A blocked call can still report prompt tokens; carry them into the bill.
    let blockedInputTokens = 0;
    if (!findAudioPart(response) && style && isSafetyBlocked(response)) {
        blockedInputTokens = response?.usageMetadata?.promptTokenCount ?? 0;
        response = await request(undefined);
        styleDropped = true;
    }

    const audioPart = findAudioPart(response);
    if (!audioPart) {
        throw new Error(`No audio data in Google TTS response (${describeEmptyTtsResponse(response)}${styleDropped ? ', also without the style' : ''})`);
    }
    const bytes = new Uint8Array(Buffer.from(audioPart.data, 'base64'));
    const isWav = /^audio\/(x-)?wav/i.test(audioPart.mimeType);
    const audio = isWav
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        : pcmToWav(bytes);
    const pcmBytes = isWav ? Math.max(0, bytes.length - WAV_HEADER_BYTES) : bytes.length;

    // Audio tokens are the candidates count; if absent, estimate from the audio
    // length rather than bill zero.
    const usageMetadata = response.usageMetadata ?? {};
    const inputTokens: number = (usageMetadata.promptTokenCount ?? 0) + blockedInputTokens;
    const reportedOutput: number | undefined = usageMetadata.candidatesTokenCount;
    const outputTokens = reportedOutput && reportedOutput > 0
        ? reportedOutput
        : Math.ceil((pcmBytes / PCM_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND);

    return {
        audio,
        usage: { inputTokens, outputTokens },
        ...(styleDropped ? { styleDropped } : {}),
    };
}
