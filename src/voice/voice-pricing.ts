import { VOICE_MODEL_CONSTANTS, VOICE_MODEL_PRICING } from './voice-catalog';

export interface TokenPairUsage {
    inputTokens: number;
    outputTokens: number;
}

function roundUSD(value: number): number {
    return parseFloat((value || 0).toFixed(6));
}

/** OpenAI TTS: USD for `characterCount` input characters. */
export function calculateOpenAiTtsCost(characterCount: number): number {
    const rate = VOICE_MODEL_PRICING[VOICE_MODEL_CONSTANTS.OPENAI_TTS]?.pricePerMillionCharacters ?? 0;
    if (!characterCount || characterCount <= 0 || rate <= 0) return 0;
    return roundUSD((characterCount / 1_000_000) * rate);
}

/** Whisper: USD for `durationSeconds` of audio. */
export function calculateOpenAiSttCost(durationSeconds: number): number {
    const rate = VOICE_MODEL_PRICING[VOICE_MODEL_CONSTANTS.OPENAI_STT]?.pricePerMinute ?? 0;
    if (!durationSeconds || durationSeconds <= 0 || rate <= 0) return 0;
    return roundUSD((durationSeconds / 60) * rate);
}

/** Gemini TTS: USD for text prompt tokens in and audio tokens out. */
export function calculateGeminiTtsCost(usage: TokenPairUsage): number {
    const pricing = VOICE_MODEL_PRICING[VOICE_MODEL_CONSTANTS.GOOGLE_TTS];
    return tokenPairCost(usage, pricing?.textInputPricePerM ?? 0, pricing?.audioOutputPricePerM ?? 0);
}

/** Gemini Transcribe: USD for audio tokens in and text tokens out. */
export function calculateGeminiSttCost(usage: TokenPairUsage): number {
    const pricing = VOICE_MODEL_PRICING[VOICE_MODEL_CONSTANTS.GOOGLE_STT];
    return tokenPairCost(usage, pricing?.audioInputPricePerM ?? 0, pricing?.textOutputPricePerM ?? 0);
}

function tokenPairCost(usage: TokenPairUsage, inputRate: number, outputRate: number): number {
    const inputTokens = Math.max(0, usage.inputTokens || 0);
    const outputTokens = Math.max(0, usage.outputTokens || 0);
    return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}
