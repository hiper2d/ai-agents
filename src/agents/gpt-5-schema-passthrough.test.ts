import { Gpt5Agent } from './gpt-5-agent';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { type AIMessage } from '../types';

/**
 * Regression guard for the whitespace runaway (2026-09-05).
 *
 * This agent used to append a required `thinking` field to the caller's schema whenever
 * thinking was enabled. OpenAI never exposes chain-of-thought, so the model had nothing to
 * put there; strict structured outputs emit keys in schema order, so the injected field came
 * last, and rather than commit to `"thinking":""` the model would emit whitespace — legal
 * everywhere in JSON — until max_output_tokens truncated the document one character short of
 * valid. Measured on gpt-6-astra with a real prompt: 3/5 calls with the field ran away,
 * 0/5 without.
 *
 * The schema must therefore reach the API exactly as the caller wrote it.
 */
const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

function agentCapturingRequest(thinkingEnabled: boolean) {
    const captured: any = {};
    const agent = new Gpt5Agent('Mira', 'instruction', 'gpt-6-astra', 'key', 1, thinkingEnabled, SILENT_LOGGING);
    (agent as any).client = {
        responses: {
            parse: async (params: any) => {
                captured.params = params;
                return { status: 'completed', output_parsed: { reply: 'hi' }, output_text: '{"reply":"hi"}' };
            },
        },
    };
    return { agent, captured };
}

function schemaOf(captured: any): any {
    return captured.params.text.format.schema;
}

describe('Gpt5Agent sends the caller schema unmodified', () => {
    it('does not inject a thinking field when thinking is enabled', async () => {
        const { agent, captured } = agentCapturingRequest(true);
        await agent.askWithZodSchema(ReplySchema, MESSAGES);

        const schema = schemaOf(captured);
        expect(Object.keys(schema.properties)).toEqual(['reply']);
        expect(schema.required).toEqual(['reply']);
        expect(JSON.stringify(schema)).not.toContain('thinking');
    });

    it('sends the same schema when thinking is disabled', async () => {
        const enabled = agentCapturingRequest(true);
        await enabled.agent.askWithZodSchema(ReplySchema, MESSAGES);
        const disabled = agentCapturingRequest(false);
        await disabled.agent.askWithZodSchema(ReplySchema, MESSAGES);

        expect(schemaOf(enabled.captured)).toEqual(schemaOf(disabled.captured));
    });

    it('still returns thinking when the caller schema declares it itself', async () => {
        const { agent } = agentCapturingRequest(true);
        (agent as any).client = {
            responses: {
                parse: async () => ({
                    status: 'completed',
                    output_parsed: { reply: 'hi', thinking: 'because' },
                    output_text: '{"reply":"hi","thinking":"because"}',
                }),
            },
        };
        const [, reasoning] = await agent.askWithZodSchema(ReplySchema, MESSAGES);
        expect(reasoning).toBe('because');
    });
});
