import { ClaudeAgent } from './anthropic-agent';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import type { AIMessage } from '../types';

/**
 * Pins the `thinking` field each Claude model gets, on both ask paths. The off switch differs
 * per model and a wrong one is a 400: Sonnet 5 takes `disabled`, Fable and Opus 5.5 reject it
 * (omit the field), Sonnet 5.5 rejects it and takes `between_tools` (no other thinking field).
 * Haiku 5.5 takes `disabled` but rejects `enabled` thinking, so it must go adaptive when on.
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
        ['claude-haiku-5-5', { type: 'disabled' }],
        ['claude-opus-5-5', undefined],
        ['claude-fable-5-1', undefined],
    ])('thinking off on %s sends %j on both paths', async (model, expected) => {
        const calls = await paramsFor(model, false);
        expect(calls).toHaveLength(2);
        for (const params of calls) {
            expect(params.thinking).toEqual(expected);
            expect(params.output_config?.effort).toBeUndefined();
            expect(params.temperature).toBeUndefined();
        }
    });

    it.each(['claude-sonnet-5-5', 'claude-haiku-5-5'])(
        'thinking on for %s stays adaptive with a summarized display and effort', async (model) => {
            const calls = await paramsFor(model, true);
            for (const params of calls) {
                expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
                expect(params.output_config.effort).toBe('high');
                expect(params.temperature).toBeUndefined();
            }
        });

    it('thinking on for Haiku 4.5 keeps the enabled budget mode', async () => {
        const calls = await paramsFor('claude-haiku-4-5', true);
        for (const params of calls) {
            expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
            expect(params.output_config?.effort).toBeUndefined();
        }
    });
});

describe('ClaudeAgent structured output', () => {
    it('sends the Zod schema as a json_schema output format on the schema path only', async () => {
        const [textCall, schemaCall] = await paramsFor('claude-sonnet-5-5', true);
        expect(textCall.output_config.format).toBeUndefined();
        expect(schemaCall.output_config).toEqual({
            effort: 'high',
            format: {
                type: 'json_schema',
                schema: expect.objectContaining({ type: 'object', additionalProperties: false, required: ['reply'] }),
            },
        });
    });

    it('keeps the format when thinking is off and no effort is sent', async () => {
        const [, schemaCall] = await paramsFor('claude-sonnet-5-5', false);
        expect(schemaCall.output_config).toEqual({
            format: { type: 'json_schema', schema: expect.objectContaining({ type: 'object' }) },
        });
    });

    it('no longer appends a prose schema description to the last message', async () => {
        const [, schemaCall] = await paramsFor('claude-sonnet-5-5', false);
        const last = schemaCall.messages[schemaCall.messages.length - 1];
        const text = typeof last.content === 'string' ? last.content : last.content.map((b: any) => b.text ?? '').join('');
        expect(text).toBe('Say something.');
    });
});
