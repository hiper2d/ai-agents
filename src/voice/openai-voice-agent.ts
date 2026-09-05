import { VOICE_MODEL_CONSTANTS } from './voice-catalog';
import { generateOpenAiTtsAudio, OpenAiTtsVoice } from './openai-tts';
import { transcribeWithOpenAi } from './openai-stt';
import { calculateOpenAiSttCost, calculateOpenAiTtsCost } from './voice-pricing';
import type { SpeechRequest, SpeechResult, TranscriptionRequest, TranscriptionResult, VoiceAgent } from './types';

/** gpt-4o-mini-tts (billed per character) + Whisper (billed per minute). */
export class OpenAiVoiceAgent implements VoiceAgent {
    readonly provider = 'openai' as const;
    readonly ttsModel = VOICE_MODEL_CONSTANTS.OPENAI_TTS;
    readonly sttModel = VOICE_MODEL_CONSTANTS.OPENAI_STT;

    constructor(private readonly apiKey: string) {}

    async speak(request: SpeechRequest): Promise<SpeechResult> {
        const audio = await generateOpenAiTtsAudio(request.text, this.apiKey, {
            voice: request.voice as OpenAiTtsVoice,
            instructions: request.voiceStyle || undefined,
        });
        const characters = request.text.length;
        return { audio, costUSD: calculateOpenAiTtsCost(characters), usage: { characters } };
    }

    async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
        const { text, durationSeconds } = await transcribeWithOpenAi(request.audio, this.apiKey, {
            language: request.language,
            prompt: request.prompt,
            fileName: request.fileName,
            mimeType: request.mimeType,
        });
        return { text, durationSeconds, costUSD: calculateOpenAiSttCost(durationSeconds), usage: { audioSeconds: durationSeconds } };
    }
}
