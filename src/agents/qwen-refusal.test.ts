import { QwenAgent } from './qwen-agent';
import { ModelRefusalError } from '../errors';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { type AIMessage } from '../types';

/**
 * Qwen's content filter is an HTTP 400 with `InternalError.Algo.DataInspectionFailed`.
 * Both ask paths must surface it as ModelRefusalError (not the wrapped "Failed to get
 * response") so a host treats it like Gemini's PROHIBITED_CONTENT: switch model, don't
 * retry. The message below is verbatim from production, 2026-09-13.
 */
const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];
const QWEN_400 = '400 <400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.';

function refusingAgent() {
    const agent = new QwenAgent('Mira', 'instruction', 'qwen-flash', 'key', 0.2, false, SILENT_LOGGING);
    (agent as any).client = { chat: { completions: { create: async () => { throw new Error(QWEN_400); } } } };
    return agent;
}

describe('QwenAgent refusal handling', () => {
    it('askText throws ModelRefusalError with reason DataInspectionFailed', async () => {
        const err = await refusingAgent().askText(MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelRefusalError);
        expect(err.reason).toBe('DataInspectionFailed');
        expect(err.message).toBe('qwen-flash refused the prompt (refusalReason: DataInspectionFailed; Input text data may contain inappropriate content.)');
    });

    it('askWithZodSchema throws the same typed error', async () => {
        const err = await refusingAgent().askWithZodSchema(ReplySchema, MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelRefusalError);
        expect(err.modelType).toBe('qwen-flash');
    });

    it('still wraps an unrelated API error generically', async () => {
        const agent = new QwenAgent('Mira', 'instruction', 'qwen-flash', 'key', 0.2, false, SILENT_LOGGING);
        (agent as any).client = { chat: { completions: { create: async () => { throw new Error('503 Service Unavailable'); } } } };
        const err = await agent.askText(MESSAGES).catch(e => e);
        expect(err).not.toBeInstanceOf(ModelRefusalError);
        expect(err.message).toMatch(/Failed to get response from Qwen API/);
    });
});
