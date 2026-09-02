import { Gpt5Agent } from './gpt-5-agent';
import { ModelInvalidResponseError } from '../errors';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { type AIMessage } from '../types';

/**
 * The Responses API can fail to produce a usable answer in two ways that are NOT
 * transport errors: output_text is malformed JSON (the SDK's responses.parse throws a
 * bare SyntaxError — a generation truncated at max_output_tokens or a runaway that never
 * closed the object), or the response parses but carries `status: "incomplete"`. Both
 * must surface as ModelInvalidResponseError so callers can show "the model failed to
 * produce a valid response" instead of a cryptic JSON error or a misleading
 * connectivity message.
 */
const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

function agentWith(client: any): Gpt5Agent {
    const agent = new Gpt5Agent('Mira', 'instruction', 'gpt-5.6-luna', 'key', 1, false, SILENT_LOGGING);
    (agent as any).client = client;
    return agent;
}

describe('Gpt5Agent invalid-response handling', () => {
    it('askWithZodSchema maps the SDK JSON SyntaxError to ModelInvalidResponseError', async () => {
        const agent = agentWith({
            responses: { parse: async () => { throw new SyntaxError("Expected ',' or '}' after property value in JSON at position 81350"); } },
        });
        const err = await agent.askWithZodSchema(ReplySchema, MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelInvalidResponseError);
        expect(err.modelType).toBe('gpt-5.6-luna');
        expect(err.message).toMatch(/failed to produce a valid response/);
        expect(err.truncated).toBe(false);
    });

    it('askWithZodSchema flags an incomplete response truncated at max_output_tokens', async () => {
        const agent = agentWith({
            responses: { parse: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_parsed: null, output_text: '{"reply":"cut off' }) },
        });
        const err = await agent.askWithZodSchema(ReplySchema, MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelInvalidResponseError);
        expect(err.truncated).toBe(true);
        expect(err.message).toMatch(/max_output_tokens=8192/);
    });

    it('askText surfaces an empty incomplete response as truncated, not "empty response"', async () => {
        const agent = agentWith({
            responses: { create: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '' }) },
        });
        const err = await agent.askText(MESSAGES).catch(e => e);
        expect(err).toBeInstanceOf(ModelInvalidResponseError);
        expect(err.truncated).toBe(true);
    });

    it('still wraps unrelated failures as the generic API error', async () => {
        const agent = agentWith({
            responses: { parse: async () => { throw new Error('socket hang up'); } },
        });
        const err = await agent.askWithZodSchema(ReplySchema, MESSAGES).catch(e => e);
        expect(err).not.toBeInstanceOf(ModelInvalidResponseError);
        expect(err.message).toMatch(/Failed to get response from OpenAI API: socket hang up/);
    });
});
