import { GoogleGenAI } from '@google/genai';
import { VOICE_MODEL_CONSTANTS } from './voice-catalog';

export interface GoogleTtsAudioOptions {
    /** e.g. "Kore", "Puck" */
    voiceName: string;
    /** "mysteriously", "excitedly", or a longer direction */
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

// Gemini reports ~32 audio tokens per second of speech (measured 2026-09-05:
// 267-304 tokens for 8-10 s). Used only when a response carries no usage.
const AUDIO_TOKENS_PER_SECOND = 32;
const SAMPLE_RATE = 24000;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2;

/**
 * Gemini TTS has no instruction field: delivery is directed in the text itself
 * ("Say cheerfully: Have a wonderful day!" in the docs). A short style (1-3
 * words) becomes that "Say X:" prefix; a longer direction is used as written,
 * ending in the colon that separates it from the line to read. The same style
 * value feeds OpenAI's `instructions`, so one field serves both providers.
 */
export function buildGoogleTtsPrompt(text: string, voiceStyle?: string): string {
    const style = voiceStyle?.trim().replace(/[:.!,;\s]+$/, '');
    if (!style) return text;
    const isShort = style.split(/\s+/).length <= 3 && !/[.!?,;]/.test(style);
    return isShort ? `Say ${style}: ${text}` : `${style}:\n${text}`;
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
 * A safety block on the prompt or the candidate. Gemini TTS false-positives on
 * some delivery directions: "Say quietly: <harmless line>" was blocked 4 of 6
 * times on 2026-09-24 while the same lines without the style passed 6 of 6.
 */
export function isSafetyBlocked(response: any): boolean {
    const finish = response?.candidates?.[0]?.finishReason;
    return finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || !!response?.promptFeedback?.blockReason;
}

function findAudioData(response: any): string | undefined {
    const parts: any[] = response?.candidates?.[0]?.content?.parts ?? [];
    return parts.find(part => part.inlineData?.mimeType?.startsWith('audio/'))?.inlineData?.data;
}

/**
 * Core Gemini TTS call: text + API key in, WAV + token usage out.
 *
 * Uses generateContent rather than the newer Interactions API the docs show:
 * both serve the 3.1 TTS model (verified 2026-09-05), and this one is typed in
 * the SDK and reports usageMetadata, which billing needs.
 *
 * When a styled request comes back safety-blocked, the line is read once more
 * without the style: the block is on the direction, not the words, and a line
 * in the default delivery beats silence. An unstyled block is not repeated.
 */
export async function generateGoogleTtsAudio(
    text: string,
    apiKey: string,
    options: GoogleTtsAudioOptions
): Promise<GoogleTtsResult> {
    const client = new GoogleGenAI({ apiKey });
    const request = (voiceStyle?: string) => client.models.generateContent({
        model: VOICE_MODEL_CONSTANTS.GOOGLE_TTS,
        contents: [{ parts: [{ text: buildGoogleTtsPrompt(text, voiceStyle) }] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } } },
        } as any,
    }) as Promise<any>;

    let response = await request(options.voiceStyle);
    let styleDropped = false;
    // A blocked call can still report prompt tokens; carry them into the bill.
    let blockedInputTokens = 0;
    if (!findAudioData(response) && options.voiceStyle?.trim() && isSafetyBlocked(response)) {
        blockedInputTokens = response?.usageMetadata?.promptTokenCount ?? 0;
        response = await request(undefined);
        styleDropped = true;
    }

    const audioData = findAudioData(response);
    if (!audioData) {
        throw new Error(`No audio data in Google TTS response (${describeEmptyTtsResponse(response)}${styleDropped ? ', also without the style' : ''})`);
    }
    const pcmData = new Uint8Array(Buffer.from(audioData, 'base64'));

    // Audio tokens are the candidates count; if absent, estimate from the audio
    // length rather than bill zero.
    const usageMetadata = response.usageMetadata ?? {};
    const inputTokens: number = (usageMetadata.promptTokenCount ?? 0) + blockedInputTokens;
    const reportedOutput: number | undefined = usageMetadata.candidatesTokenCount;
    const outputTokens = reportedOutput && reportedOutput > 0
        ? reportedOutput
        : Math.ceil((pcmData.length / PCM_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND);

    return {
        audio: pcmToWav(pcmData),
        usage: { inputTokens, outputTokens },
        ...(styleDropped ? { styleDropped } : {}),
    };
}
