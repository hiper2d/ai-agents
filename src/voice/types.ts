/**
 * Voice agents: the speech counterpart of the text agents. One agent per
 * provider, chosen through `VoiceAgentFactory` — a caller asks for a provider
 * and gets `speak()` / `transcribe()` without knowing which SDK or model is
 * behind them. Agents are pure: no auth, tier or billing logic. Each result
 * carries what the call produced and what it cost, and the host decides whom
 * to bill.
 */

export type VoiceProvider = 'openai' | 'google';

export interface SpeechRequest {
    text: string;
    /** A voice id of this provider's set (e.g. OpenAI "onyx", Gemini "Kore"). */
    voice: string;
    /** Delivery direction: a short adverb ("mysteriously") or a longer sentence. */
    voiceStyle?: string;
}

export interface SpeechUsage {
    /** OpenAI bills speech per input character. */
    characters?: number;
    /** Gemini bills speech per token: text prompt in, audio out. */
    inputTokens?: number;
    outputTokens?: number;
}

export interface SpeechResult {
    /** WAV audio (24 kHz mono 16-bit from Gemini; OpenAI's default WAV). */
    audio: ArrayBuffer;
    costUSD: number;
    usage: SpeechUsage;
}

export interface TranscriptionRequest {
    audio: ArrayBuffer;
    /** Container of the recording, e.g. "audio/webm" (browser MediaRecorder) or "audio/wav". */
    mimeType?: string;
    /** Whisper reads the container from the file name's extension. */
    fileName?: string;
    language?: string;
    prompt?: string;
}

export interface TranscriptionUsage {
    /** Whisper bills per minute of audio. */
    audioSeconds?: number;
    /** Gemini bills per token: audio in (~25/s), text out. */
    inputTokens?: number;
    outputTokens?: number;
}

export interface TranscriptionResult {
    text: string;
    /** Audio length; Gemini reports none, so it is derived from audio tokens. */
    durationSeconds: number;
    costUSD: number;
    usage: TranscriptionUsage;
}

export interface VoiceAgent {
    readonly provider: VoiceProvider;
    readonly ttsModel: string;
    readonly sttModel: string;
    speak(request: SpeechRequest): Promise<SpeechResult>;
    transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
