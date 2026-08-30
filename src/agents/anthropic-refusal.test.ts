import { ClaudeAgent } from './anthropic-agent';
import { ModelRefusalError } from '../errors';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { BotResponseError, type AIMessage } from '../types';

/**
 * Anthropic signals a safety refusal as `stop_reason: "refusal"` with an empty content
 * array. Both ask paths must surface that as ModelRefusalError — not the generic "Empty
 * response" — so a caller can tell "change the prompt" from "retry".
 */
const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

function refusingAgent() {
    const agent = new ClaudeAgent('Mira', 'instruction', 'claude-sonnet-5', 'key', false, SILENT_LOGGING);
    (agent as any).client = {
        messages: { create: async () => ({ id: 'msg', stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } }) },
    };
    return agent;
}

describe('ClaudeAgent refusal handling', () => {
    it('askText throws ModelRefusalError on stop_reason refusal', async () => {
        await expect(refusingAgent().askText(MESSAGES)).rejects.toBeInstanceOf(ModelRefusalError);
    });

    it('askWithZodSchema throws ModelRefusalError on stop_reason refusal', async () => {
        const err = await refusingAgent().askWithZodSchema(ReplySchema, MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelRefusalError);
        expect(err.modelType).toBe('claude-sonnet-5');
        expect(err.message).toMatch(/refused/);
    });

    it('still reports a plain empty response as the wrapped generic error', async () => {
        const agent = new ClaudeAgent('Mira', 'instruction', 'claude-sonnet-5', 'key', false, SILENT_LOGGING);
        (agent as any).client = { messages: { create: async () => ({ id: 'msg', stop_reason: 'end_turn', content: [] }) } };
        const err = await agent.askText(MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(BotResponseError);
        expect(err).not.toBeInstanceOf(ModelRefusalError);
        expect(err.details).toMatch(/Empty response/);
    });
});
