import { GoogleAgent, throwForEmptyGeminiResponse } from './google-agent';
import { ModelInvalidResponseError, ModelRefusalError } from '../errors';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { type AIMessage } from '../types';

/**
 * Gemini signals a refused PROMPT as a 200 with no candidates and
 * `promptFeedback.blockReason`, and a refused ANSWER as a candidate whose finishReason
 * names the filter. Both ask paths must surface that as ModelRefusalError carrying the
 * reason — not the generic "Empty response" — so a caller can tell "change the model or
 * the prompt" from "retry". The blockReason shape below is the exact production
 * response of 2026-09-13 (Gemini 3.8 Flash, PROHIBITED_CONTENT, 0 output tokens).
 */
const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

const promptBlocked = {
    text: undefined,
    candidates: undefined,
    promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
    usageMetadata: { promptTokenCount: 9140, totalTokenCount: 9140 },
};

function agentReturning(response: any) {
    const agent = new GoogleAgent('Mira', 'instruction', 'gemini-3.8-flash', 'key', false, SILENT_LOGGING);
    (agent as any).client = { models: { generateContent: async () => response } };
    return agent;
}

describe('GoogleAgent refusal handling', () => {
    it('askText throws ModelRefusalError with the blockReason on a blocked prompt', async () => {
        const err = await agentReturning(promptBlocked).askText(MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelRefusalError);
        expect(err.reason).toBe('PROHIBITED_CONTENT');
        expect(err.modelType).toBe('gemini-3.8-flash');
        expect(err.message).toBe('gemini-3.8-flash refused the prompt (blockReason: PROHIBITED_CONTENT)');
    });

    it('askWithZodSchema throws ModelRefusalError on a blocked prompt', async () => {
        const err = await agentReturning(promptBlocked).askWithZodSchema(ReplySchema, MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelRefusalError);
        expect(err.reason).toBe('PROHIBITED_CONTENT');
    });

    it('reports a SAFETY finish on the candidate as a refusal, naming the flagged categories', () => {
        const response = {
            text: undefined,
            candidates: [{
                finishReason: 'SAFETY',
                safetyRatings: [
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', probability: 'HIGH', blocked: true },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' },
                ],
            }],
        };
        const err = (() => { try { throwForEmptyGeminiResponse('gemini-x', response, 'Empty'); } catch (e) { return e as any; } })();
        expect(err).toBeInstanceOf(ModelRefusalError);
        expect(err.reason).toBe('SAFETY');
        expect(err.message).toBe('gemini-x refused to answer (finishReason: SAFETY; safetyRatings: HARM_CATEGORY_SEXUALLY_EXPLICIT=HIGH)');
    });

    it('reports an empty MAX_TOKENS candidate as a truncated invalid response, not a refusal', () => {
        const err = (() => { try { throwForEmptyGeminiResponse('gemini-x', { candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'Empty'); } catch (e) { return e as any; } })();
        expect(err).toBeInstanceOf(ModelInvalidResponseError);
        expect(err.truncated).toBe(true);
    });

    it('still reports a plain empty response as the wrapped generic error, naming what it saw', async () => {
        const err = await agentReturning({ text: '', candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }).askText(MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(ModelRefusalError);
        expect(err.message).toBe('Empty response from Google API (finishReason=STOP)');
    });
});
