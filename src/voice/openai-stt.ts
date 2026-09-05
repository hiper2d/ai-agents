import { OpenAI } from 'openai';
import { VOICE_MODEL_CONSTANTS } from './voice-catalog';

export interface OpenAiSttOptions {
    language?: string;
    prompt?: string;
    temperature?: number;
    /** Whisper detects the container format from the extension. */
    fileName?: string;
    mimeType?: string;
}

export interface OpenAiSttResult {
    text: string;
    durationSeconds: number;
}

/** Core Whisper call: audio + API key in, transcript + duration out. */
export async function transcribeWithOpenAi(
    audioBuffer: ArrayBuffer,
    apiKey: string,
    options: OpenAiSttOptions = {}
): Promise<OpenAiSttResult> {
    const client = new OpenAI({ apiKey });
    const audioFile = new File([new Uint8Array(audioBuffer)], options.fileName || 'audio.webm', { type: options.mimeType || 'audio/webm' });

    const transcription: any = await client.audio.transcriptions.create({
        file: audioFile,
        model: VOICE_MODEL_CONSTANTS.OPENAI_STT,
        language: options.language || 'en',
        prompt: options.prompt,
        temperature: options.temperature || 0,
        response_format: 'verbose_json',
    });

    const explicitDuration = Number(transcription?.duration) || 0;
    const segments: any[] = Array.isArray(transcription?.segments) ? transcription.segments : [];
    const segmentsDuration = segments.reduce((max: number, segment: any) => {
        const end = Number(segment?.end);
        return end > max ? end : max;
    }, 0);
    const text = typeof transcription?.text === 'string'
        ? transcription.text
        : segments.map((segment: any) => segment?.text || '').join(' ');

    return { text: text.trim(), durationSeconds: explicitDuration || segmentsDuration };
}
