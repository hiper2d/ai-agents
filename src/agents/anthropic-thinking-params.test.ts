import { ClaudeAgent } from './anthropic-agent';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import type { AIMessage } from '../types';

/**
 * Pins the `thinking` field each Claude model gets, on both ask paths. The off switch differs
 * per model and a wrong one is a 400: Sonnet 5 takes `disabled`, Fable and Opus 5.5 reject it
 * (omit the field), Sonnet 5.5 rejects it and takes `between_tools` (no other thinking field).
 */
const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

function capture(model: string, enableThinking: boolean) {
    const agent = new ClaudeAgent('Mira', 'instruction', model, 'key', enableThinking, SILENT_LOGGING);
    const calls: any[] = [];
    (agent as any).client = {
        messages: {
            create: async (params: any) => {
                calls.push(params);
                return {
                    id: 'msg', stop_reason: 'end_turn',
                    content: [{ type: 'text', text: '{"reply":"hi"}' }],
                    usage: { input_tokens: 10, output_tokens: 5 },
                };
            },
        },
    };
    return { agent, calls };
}

async function paramsFor(model: string, enableThinking: boolean) {
    const { agent, calls } = capture(model, enableThinking);
    await agent.askText(MESSAGES);
    await agent.askWithZodSchema(ReplySchema, MESSAGES).catch(() => undefined);
    return calls;
}

describe('ClaudeAgent thinking params', () => {
    it.each([
        ['claude-sonnet-5', { type: 'disabled' }],
        ['claude-sonnet-5-5', { type: 'between_tools' }],
        ['claude-opus-5-5', undefined],
        ['claude-fable-5-1', undefined],
    ])('thinking off on %s sends %j on both paths', async (model, expected) => {
        const calls = await paramsFor(model, false);
        expect(calls).toHaveLength(2);
        for (const params of calls) {
            expect(params.thinking).toEqual(expected);
            expect(params.output_config).toBeUndefined();
            expect(params.temperature).toBeUndefined();
        }
    });

    it('thinking on for Sonnet 5.5 stays adaptive with a summarized display and effort', async () => {
        const calls = await paramsFor('claude-sonnet-5-5', true);
        for (const params of calls) {
            expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
            expect(params.output_config).toEqual({ effort: 'high' });
        }
    });
});
