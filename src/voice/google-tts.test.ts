const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent } })),
}));

import { generateGoogleTtsAudio, isSafetyBlocked } from './google-tts';

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.alloc(48000)]); // 1 s of 24 kHz 16-bit
const audio = (promptTokenCount = 20, mimeType = 'audio/wav', data: Buffer = WAV, usage = true) => ({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] } }],
    usageMetadata: usage ? { promptTokenCount, candidatesTokenCount: 300 } : undefined,
});
const blocked = { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 25 } };
const partOf = (call: number) => generateContent.mock.calls[call][0].contents[0].parts[0];

describe('generateGoogleTtsAudio', () => {
    beforeEach(() => generateContent.mockReset());

    it('sends the style as speechMetadata, not in the transcript, and makes one call', async () => {
        generateContent.mockResolvedValueOnce(audio());
        const r = await generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore', voiceStyle: 'quietly.' });
        expect(generateContent).toHaveBeenCalledTimes(1);
        expect(partOf(0)).toEqual({ text: 'Hello.', speechMetadata: { style: 'quietly' } });
        expect(r.styleDropped).toBeUndefined();
        expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 300 });
    });

    it('reads the line without its style after a safety block, billing both prompts', async () => {
        generateContent.mockResolvedValueOnce(blocked).mockResolvedValueOnce(audio(15));
        const r = await generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore', voiceStyle: 'quietly' });
        expect(generateContent).toHaveBeenCalledTimes(2);
        expect(partOf(1)).toEqual({ text: 'Hello.' });
        expect(r.styleDropped).toBe(true);
        expect(r.usage).toEqual({ inputTokens: 40, outputTokens: 300 });
    });

    it('does not repeat an unstyled safety block', async () => {
        generateContent.mockResolvedValue(blocked);
        await expect(generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore' }))
            .rejects.toThrow('finishReason=SAFETY');
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it('fails when the unstyled read is blocked too, saying so', async () => {
        generateContent.mockResolvedValue(blocked);
        await expect(generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore', voiceStyle: 'quietly' }))
            .rejects.toThrow('also without the style');
        expect(generateContent).toHaveBeenCalledTimes(2);
    });

    it('does not drop the style for a non-safety empty response', async () => {
        generateContent.mockResolvedValue({ candidates: [{ finishReason: 'OTHER' }] });
        await expect(generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore', voiceStyle: 'quietly' }))
            .rejects.toThrow('finishReason=OTHER');
        expect(generateContent).toHaveBeenCalledTimes(1);
    });
});

describe('generateGoogleTtsAudio audio formats', () => {
    beforeEach(() => generateContent.mockReset());

    it('passes WAV through untouched', async () => {
        generateContent.mockResolvedValueOnce(audio());
        const r = await generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore' });
        expect(Buffer.from(r.audio).equals(WAV)).toBe(true);
    });

    it('wraps headerless PCM in a WAV header', async () => {
        const pcm = Buffer.alloc(48000);
        generateContent.mockResolvedValueOnce(audio(20, 'audio/L16;rate=24000', pcm));
        const r = await generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore' });
        expect(r.audio.byteLength).toBe(48044);
        expect(Buffer.from(r.audio.slice(0, 4)).toString('ascii')).toBe('RIFF');
    });

    it('estimates audio tokens from the WAV length when usage is missing', async () => {
        generateContent.mockResolvedValueOnce(audio(20, 'audio/wav', WAV, false));
        const r = await generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore' });
        expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 32 });
    });
});

describe('isSafetyBlocked', () => {
    it('recognises candidate and prompt-level blocks', () => {
        expect(isSafetyBlocked(blocked)).toBe(true);
        expect(isSafetyBlocked({ promptFeedback: { blockReason: 'OTHER' } })).toBe(true);
        expect(isSafetyBlocked(audio())).toBe(false);
    });
});
