import { AIMessage } from '../types';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { MetaAgent } from './meta-agent';
import { LLM_CONSTANTS, SupportedAiModels, MODEL_PRICING } from '../catalog';

/**
 * Request-shape guard for the Meta Model API agent (mocked, free). Pins the wire contract
 * on both ask paths — reasoning effort from the catalog (clamped to Meta's vocabulary),
 * encrypted-reasoning replay, prompt cache routing, json_schema structured output — and
 * the usage → cost mapping, so a refactor can't silently drop any of them.
 */

const MODEL = SupportedAiModels[LLM_CONSTANTS.MUSE_SPARK].modelApiName;
const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

function makeAgent(response: any): { agent: MetaAgent; captured: { params?: any } } {
    const agent = new MetaAgent('Mira', 'instruction', MODEL, 'key', 1, true, SILENT_LOGGING);
    const captured: { params?: any } = {};
    (agent as any).client = {
        responses: { create: async (params: any) => { captured.params = params; return response; } },
    };
    return { agent, captured };
}

const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought about it' }], encrypted_content: 'enc' };
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const usage = { input_tokens: 1000, output_tokens: 400, total_tokens: 1400, output_tokens_details: { reasoning_tokens: 300 }, input_tokens_details: { cached_tokens: 600 } };

const textResponse = { output: [reasoningItem, message('hello')], usage };
const jsonResponse = { output: [reasoningItem, message('{"reply":"hello"}')], usage };

describe('MetaAgent request shape', () => {
    it('askText: Responses API with catalog effort, summary, encrypted reasoning, no store, cache key', async () => {
        const { agent, captured } = makeAgent(textResponse);
        await agent.askText(MESSAGES);

        const p = captured.params;
        expect(p.model).toBe(MODEL);
        expect(p.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
        expect(p.include).toEqual(['reasoning.encrypted_content']);
        expect(p.store).toBe(false);
        expect(p.max_output_tokens).toBe(agent.maxOutputTokens);
        expect(typeof p.prompt_cache_key).toBe('string');
        expect(p.prompt_cache_key.length).toBeGreaterThan(0);
        expect(p.text).toBeUndefined();
        // System instruction leads the input.
        expect(p.input[0]).toEqual({ role: 'system', content: 'instruction' });
        expect(p.input[1]).toEqual({ role: 'user', content: 'Say something.' });
    });

    it('askWithZodSchema: json_schema format (strict false) plus the schema described in the prompt', async () => {
        const { agent, captured } = makeAgent(jsonResponse);
        const [reply] = await agent.askWithZodSchema(ReplySchema, MESSAGES);

        expect(reply).toEqual({ reply: 'hello' });
        const format = captured.params.text.format;
        expect(format.type).toBe('json_schema');
        expect(format.strict).toBe(false);
        expect(format.schema.type).toBe('object');
        expect(format.schema.properties.reply).toBeDefined();
        expect(captured.params.input.at(-1).content).toContain('valid JSON object matching this schema');
    });

    it('a per-instance effort override is clamped to Meta\'s vocabulary and sent', async () => {
        const { agent, captured } = makeAgent(textResponse);
        agent.reasoningEffort = 'max';
        await agent.askText(MESSAGES);
        expect(captured.params.reasoning.effort).toBe('max');
    });

    it('no pinned effort: only the summary is requested, leaving Meta\'s default depth', async () => {
        const { agent, captured } = makeAgent(textResponse);
        agent.reasoningEffort = undefined;
        await agent.askText(MESSAGES);
        expect(captured.params.reasoning).toEqual({ summary: 'auto' });
    });

    it('the same bot + prompt always routes to the same prompt_cache_key', async () => {
        const a = makeAgent(textResponse);
        const b = makeAgent(textResponse);
        await a.agent.askText(MESSAGES);
        await b.agent.askText(MESSAGES);
        expect(a.captured.params.prompt_cache_key).toBe(b.captured.params.prompt_cache_key);
    });
});

describe('MetaAgent response handling', () => {
    it('returns the text, the reasoning summary, usage with cost, and the encrypted items', async () => {
        const { agent } = makeAgent(textResponse);
        const [text, thinking, tokenUsage, encrypted] = await agent.askText(MESSAGES);

        expect(text).toBe('hello');
        expect(thinking).toBe('thought about it');
        expect(JSON.parse(encrypted!)).toEqual([reasoningItem]);

        const price = MODEL_PRICING[MODEL];
        const expectedCost = (400 * price.inputPrice + 600 * price.cacheHitPrice! + 400 * price.outputPrice) / 1_000_000;
        // durationMs is stamped by AbstractAgent's template method.
        expect(tokenUsage).toEqual({
            inputTokens: 1000, outputTokens: 400, totalTokens: 1400,
            costUSD: expect.closeTo(expectedCost, 8),
            reasoningTokens: 300, cachedInputTokens: 600,
            durationMs: expect.any(Number),
        });
    });

    it('replays stored encrypted reasoning right before its assistant message', async () => {
        const { agent, captured } = makeAgent(textResponse);
        const history: AIMessage[] = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello', metaEncryptedReasoning: JSON.stringify([reasoningItem]) },
            { role: 'user', content: 'Again?' },
        ];
        await agent.askText(history);

        const roles = captured.params.input.map((i: any) => i.type ?? i.role);
        expect(roles).toEqual(['system', 'user', 'reasoning', 'assistant', 'user']);
    });

    it('unparseable stored reasoning is dropped, not fatal', async () => {
        const { agent, captured } = makeAgent(textResponse);
        await agent.askText([{ role: 'assistant', content: 'Hello', metaEncryptedReasoning: '{not json' }, { role: 'user', content: 'x' }]);
        expect(captured.params.input.some((i: any) => i.type === 'reasoning')).toBe(false);
    });

    it('an empty output surfaces as the agent\'s wrapped error', async () => {
        const { agent } = makeAgent({ output: [reasoningItem], usage });
        await expect(agent.askText(MESSAGES)).rejects.toThrow('Failed to get response from Meta API: Empty or undefined response from Meta API');
    });

    it('a provider error is wrapped with the Meta prefix', async () => {
        const { agent } = makeAgent(null);
        (agent as any).client = { responses: { create: async () => { throw new Error('429 rate limit'); } } };
        await expect(agent.askText(MESSAGES)).rejects.toThrow('Failed to get response from Meta API: 429 rate limit');
    });
});
