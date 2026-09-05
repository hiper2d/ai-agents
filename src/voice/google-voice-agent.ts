import { VOICE_MODEL_CONSTANTS } from './voice-catalog';
import { generateGoogleTtsAudio } from './google-tts';
import { transcribeWithGemini } from './google-stt';
import { calculateGeminiSttCost, calculateGeminiTtsCost } from './voice-pricing';
import type { SpeechRequest, SpeechResult, TranscriptionRequest, TranscriptionResult, VoiceAgent } from './types';

/** Gemini 3.1 Flash TTS + Gemini 3.5 Transcribe, both billed per token. */
export class GoogleVoiceAgent implements VoiceAgent {
    readonly provider = 'google' as const;
    readonly ttsModel = VOICE_MODEL_CONSTANTS.GOOGLE_TTS;
    readonly sttModel = VOICE_MODEL_CONSTANTS.GOOGLE_STT;

    constructor(private readonly apiKey: string) {}

    async speak(request: SpeechRequest): Promise<SpeechResult> {
        const { audio, usage } = await generateGoogleTtsAudio(request.text, this.apiKey, {
            voiceName: request.voice,
            voiceStyle: request.voiceStyle,
        });
        return { audio, costUSD: calculateGeminiTtsCost(usage), usage };
    }

    async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
        const { text, durationSeconds, usage } = await transcribeWithGemini(request.audio, this.apiKey, { mimeType: request.mimeType });
        return { text, durationSeconds, costUSD: calculateGeminiSttCost(usage), usage };
    }
}
