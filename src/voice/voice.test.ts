import { buildGoogleTtsPrompt, pcmToWav } from './google-tts';
import { calculateGeminiSttCost, calculateGeminiTtsCost, calculateOpenAiSttCost, calculateOpenAiTtsCost } from './voice-pricing';
import { createVoiceAgent, VoiceAgentFactory } from './voice-agent-factory';
import { OpenAiVoiceAgent } from './openai-voice-agent';
import { GoogleVoiceAgent } from './google-voice-agent';
import { SUPPORTED_VOICE_PROVIDERS, VOICE_MODEL_CONSTANTS, VOICE_MODEL_PRICING, VOICE_PROVIDER_API_KEY } from './voice-catalog';
import { API_KEY_CONSTANTS } from '../catalog';

describe('buildGoogleTtsPrompt', () => {
    const line = 'The werewolf hides among the villagers.';

    it('returns the line untouched without a style', () => {
        expect(buildGoogleTtsPrompt(line)).toBe(line);
        expect(buildGoogleTtsPrompt(line, '   ')).toBe(line);
    });

    it('turns a short style into the documented "Say X:" prefix', () => {
        expect(buildGoogleTtsPrompt(line, 'mysteriously')).toBe(`Say mysteriously: ${line}`);
        expect(buildGoogleTtsPrompt(line, 'warmly and slowly')).toBe(`Say warmly and slowly: ${line}`);
    });

    it('uses a longer direction as written, separated from the line by a colon', () => {
        expect(buildGoogleTtsPrompt(line, 'Speak like a tired old sailor, slow and gravelly.'))
            .toBe(`Speak like a tired old sailor, slow and gravelly:\n${line}`);
    });

    it('does not double a trailing colon', () => {
        expect(buildGoogleTtsPrompt(line, 'Whisper this:')).toBe(`Say Whisper this: ${line}`);
    });
});

describe('pcmToWav', () => {
    it('writes a 44-byte RIFF header ahead of the samples', () => {
        const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]));
        expect(wav.byteLength).toBe(48);
        expect(Buffer.from(wav.slice(0, 4)).toString('ascii')).toBe('RIFF');
        expect(new DataView(wav).getUint32(24, true)).toBe(24000);
        expect(new DataView(wav).getUint32(40, true)).toBe(4);
    });
});

describe('voice pricing', () => {
    it('OpenAI: per character and per minute, rounded to micro-dollars', () => {
        expect(calculateOpenAiTtsCost(1_000_000)).toBe(15);
        expect(calculateOpenAiTtsCost(0)).toBe(0);
        expect(calculateOpenAiSttCost(60)).toBe(0.006);
        expect(calculateOpenAiSttCost(-1)).toBe(0);
    });

    it('Gemini TTS: text in and audio out at their own rates', () => {
        expect(calculateGeminiTtsCost({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1, 10);
        expect(calculateGeminiTtsCost({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(20, 10);
        expect(calculateGeminiTtsCost({ inputTokens: 18, outputTokens: 285 })).toBeCloseTo(0.000018 + 0.0057, 10);
        expect(calculateGeminiTtsCost({ inputTokens: -5, outputTokens: NaN })).toBe(0);
    });

    it('Gemini Transcribe: about half a cent per minute at the documented token rates', () => {
        expect(calculateGeminiSttCost({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2, 10);
        expect(calculateGeminiSttCost({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(12, 10);
        expect(calculateGeminiSttCost({ inputTokens: 1500, outputTokens: 175 })).toBeCloseTo(0.0051, 10);
    });

    it('every voice model has a price entry', () => {
        for (const model of Object.values(VOICE_MODEL_CONSTANTS)) {
            expect(VOICE_MODEL_PRICING[model]).toBeDefined();
        }
    });
});

describe('VoiceAgentFactory', () => {
    it('returns the provider agent with its speech and transcription models', () => {
        const openai = createVoiceAgent('openai', 'k');
        expect(openai).toBeInstanceOf(OpenAiVoiceAgent);
        expect(openai.ttsModel).toBe(VOICE_MODEL_CONSTANTS.OPENAI_TTS);
        expect(openai.sttModel).toBe(VOICE_MODEL_CONSTANTS.OPENAI_STT);

        const google = VoiceAgentFactory.createAgent('google', 'k');
        expect(google).toBeInstanceOf(GoogleVoiceAgent);
        expect(google.ttsModel).toBe('gemini-3.1-flash-tts-preview');
        expect(google.sttModel).toBe('gemini-3.5-transcribe');
    });

    it('rejects unknown providers', () => {
        expect(() => createVoiceAgent('azure' as any, 'k')).toThrow('Unknown voice provider');
    });

    it('resolves the key from a key map by the provider\'s key name', () => {
        const agent = VoiceAgentFactory.createAgentFromKeys('google', { [API_KEY_CONSTANTS.GOOGLE]: 'g' });
        expect(agent.provider).toBe('google');
        expect(() => VoiceAgentFactory.createAgentFromKeys('openai', {})).toThrow('Missing API key OPENAI_API_KEY');
    });

    it('maps every supported provider to a key name', () => {
        for (const provider of SUPPORTED_VOICE_PROVIDERS) {
            expect(VOICE_PROVIDER_API_KEY[provider]).toBeTruthy();
        }
    });
});
