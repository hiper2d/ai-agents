/**
 * Live contract tests for the voice agents (real OpenAI and Gemini calls — cost a
 * fraction of a cent, need OPENAI_API_KEY / GOOGLE_API_KEY in .env). Run with
 * `npm run test:live -- src/voice/voice.live`.
 *
 * What these pin: both providers return playable WAV for a styled line, report
 * usage the cost function can price, and transcribe their own speech back
 * (TTS → STT roundtrip) with non-zero usage.
 */
import { VoiceAgentFactory } from './voice-agent-factory';
import { VOICE_PROVIDER_API_KEY } from './voice-catalog';
import { liveApiKeys } from '../testing/fixtures';

const SAMPLE_TEXT = 'The werewolf hides among the villagers.';
const keys = liveApiKeys();

function expectWavAudio(audio: ArrayBuffer) {
    expect(audio.byteLength).toBeGreaterThan(1000);
    expect(Buffer.from(audio.slice(0, 4)).toString('ascii')).toBe('RIFF');
}

for (const [provider, voice] of [['openai', 'onyx'], ['google', 'Kore']] as const) {
    const apiKey = keys[VOICE_PROVIDER_API_KEY[provider]];
    const describeLive = apiKey ? describe : describe.skip;

    describeLive(`${provider} voice agent (live)`, () => {
        const agent = VoiceAgentFactory.createAgent(provider, apiKey!);

        it('speaks a styled line as WAV with priced usage', async () => {
            const { audio, costUSD, usage } = await agent.speak({ text: SAMPLE_TEXT, voice, voiceStyle: 'mysteriously' });
            expectWavAudio(audio);
            expect(costUSD).toBeGreaterThan(0);
            expect(Object.values(usage).some(v => (v ?? 0) > 0)).toBe(true);
        });

        it('transcribes its own speech back (TTS → STT roundtrip)', async () => {
            const { audio } = await agent.speak({ text: SAMPLE_TEXT, voice });
            const { text, durationSeconds, costUSD } = await agent.transcribe({ audio, mimeType: 'audio/wav', fileName: 'audio.wav' });
            expect(text.toLowerCase()).toContain('werewolf');
            expect(durationSeconds).toBeGreaterThan(0);
            expect(costUSD).toBeGreaterThan(0);
        });
    });
}
