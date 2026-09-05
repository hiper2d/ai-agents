import { API_KEY_CONSTANTS } from '../catalog';
import type { VoiceProvider } from './types';

/** Speech and transcription models behind each voice provider. */
export const VOICE_MODEL_CONSTANTS = {
    OPENAI_TTS: 'gpt-4o-mini-tts',
    OPENAI_STT: 'whisper-1',
    // ai.google.dev/gemini-api/docs/speech-generation
    GOOGLE_TTS: 'gemini-3.1-flash-tts-preview',
    // ai.google.dev/gemini-api/docs/transcribe — Interactions API only (see google-stt.ts)
    GOOGLE_STT: 'gemini-3.5-transcribe',
} as const;

export const SUPPORTED_VOICE_PROVIDERS: readonly VoiceProvider[] = ['openai', 'google'];

/** Which API key (by API_KEY_CONSTANTS name) a voice provider runs on. */
export const VOICE_PROVIDER_API_KEY: Record<VoiceProvider, string> = {
    openai: API_KEY_CONSTANTS.OPENAI,
    google: API_KEY_CONSTANTS.GOOGLE,
};

export interface VoiceModelPricing {
    /** OpenAI TTS: USD per 1M input characters. */
    pricePerMillionCharacters?: number;
    /** Whisper: USD per minute of audio. */
    pricePerMinute?: number;
    /** Gemini TTS: text prompt in, audio tokens out. */
    textInputPricePerM?: number;
    audioOutputPricePerM?: number;
    /** Gemini Transcribe: audio tokens in, text tokens out. */
    audioInputPricePerM?: number;
    textOutputPricePerM?: number;
}

/** Prices as of 2026-09 (openai.com/api/pricing, ai.google.dev/gemini-api/docs/pricing). */
export const VOICE_MODEL_PRICING: Record<string, VoiceModelPricing> = {
    [VOICE_MODEL_CONSTANTS.OPENAI_TTS]: { pricePerMillionCharacters: 15 },
    [VOICE_MODEL_CONSTANTS.OPENAI_STT]: { pricePerMinute: 0.006 },
    // Measured 2026-09-05: ~32 audio tokens per second of speech, so a 15-second
    // line is ~$0.01 — about 3-5x an OpenAI line of the same length.
    [VOICE_MODEL_CONSTANTS.GOOGLE_TTS]: { textInputPricePerM: 1, audioOutputPricePerM: 20 },
    // ~25 audio tokens per second in, ~175 text tokens per minute out: ≈ $0.005/min.
    [VOICE_MODEL_CONSTANTS.GOOGLE_STT]: { audioInputPricePerM: 2, textOutputPricePerM: 12 },
};
