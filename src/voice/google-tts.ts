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
 * Core Gemini TTS call: text + API key in, WAV + token usage out.
 *
 * Uses generateContent rather than the newer Interactions API the docs show:
 * both serve the 3.1 TTS model (verified 2026-09-05), and this one is typed in
 * the SDK and reports usageMetadata, which billing needs.
 */
export async function generateGoogleTtsAudio(
    text: string,
    apiKey: string,
    options: GoogleTtsAudioOptions
): Promise<GoogleTtsResult> {
    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
        model: VOICE_MODEL_CONSTANTS.GOOGLE_TTS,
        contents: [{ parts: [{ text: buildGoogleTtsPrompt(text, options.voiceStyle) }] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } } },
        } as any,
    });

    const parts: any[] = (response as any).candidates?.[0]?.content?.parts ?? [];
    const audioPart = parts.find(part => part.inlineData?.mimeType?.startsWith('audio/'));
    if (!audioPart?.inlineData?.data) {
        throw new Error('No audio data in Google TTS response');
    }
    const pcmData = new Uint8Array(Buffer.from(audioPart.inlineData.data as string, 'base64'));

    // Audio tokens are the candidates count; if absent, estimate from the audio
    // length rather than bill zero.
    const usageMetadata = (response as any).usageMetadata ?? {};
    const inputTokens: number = usageMetadata.promptTokenCount ?? 0;
    const reportedOutput: number | undefined = usageMetadata.candidatesTokenCount;
    const outputTokens = reportedOutput && reportedOutput > 0
        ? reportedOutput
        : Math.ceil((pcmData.length / PCM_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND);

    return { audio: pcmToWav(pcmData), usage: { inputTokens, outputTokens } };
}
