const generateContent = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent } })),
}));

import { generateGoogleTtsAudio, isSafetyBlocked } from './google-tts';

const audio = (promptTokenCount = 20) => ({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.from([1, 2, 3, 4]).toString('base64') } }] } }],
    usageMetadata: { promptTokenCount, candidatesTokenCount: 300 },
});
const blocked = { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 25 } };
const promptOf = (call: number) => generateContent.mock.calls[call][0].contents[0].parts[0].text;

describe('generateGoogleTtsAudio', () => {
    beforeEach(() => generateContent.mockReset());

    it('sends the style and makes one call when audio comes back', async () => {
        generateContent.mockResolvedValueOnce(audio());
        const r = await generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore', voiceStyle: 'quietly' });
        expect(generateContent).toHaveBeenCalledTimes(1);
        expect(promptOf(0)).toBe('Say quietly: Hello.');
        expect(r.styleDropped).toBeUndefined();
        expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 300 });
    });

    it('reads the line without its style after a safety block, billing both prompts', async () => {
        generateContent.mockResolvedValueOnce(blocked).mockResolvedValueOnce(audio(15));
        const r = await generateGoogleTtsAudio('Hello.', 'k', { voiceName: 'Kore', voiceStyle: 'quietly' });
        expect(generateContent).toHaveBeenCalledTimes(2);
        expect(promptOf(1)).toBe('Hello.');
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

describe('isSafetyBlocked', () => {
    it('recognises candidate and prompt-level blocks', () => {
        expect(isSafetyBlocked(blocked)).toBe(true);
        expect(isSafetyBlocked({ promptFeedback: { blockReason: 'OTHER' } })).toBe(true);
        expect(isSafetyBlocked(audio())).toBe(false);
    });
});
