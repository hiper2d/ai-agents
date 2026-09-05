import { OpenAI } from 'openai';
import { VOICE_MODEL_CONSTANTS } from './voice-catalog';

export type OpenAiTtsVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'ash' | 'ballad' | 'coral' | 'sage';

export interface OpenAiTtsAudioOptions {
    voice?: OpenAiTtsVoice;
    /** Delivery direction; gpt-4o-mini-tts follows it closely. */
    instructions?: string;
    speed?: number;
    format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
}

/** Core OpenAI TTS call: text + API key in, audio bytes out (WAV by default). */
export async function generateOpenAiTtsAudio(
    text: string,
    apiKey: string,
    options: OpenAiTtsAudioOptions = {}
): Promise<ArrayBuffer> {
    const client = new OpenAI({ apiKey });
    const speechOptions: any = {
        model: VOICE_MODEL_CONSTANTS.OPENAI_TTS,
        voice: options.voice || 'alloy',
        input: text,
        speed: options.speed || 1.0,
        response_format: options.format || 'wav',
    };
    if (options.instructions) {
        speechOptions.instructions = options.instructions;
    }
    const response = await client.audio.speech.create(speechOptions);
    return await response.arrayBuffer();
}
