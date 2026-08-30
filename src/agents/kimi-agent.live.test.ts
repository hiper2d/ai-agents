/**
 * Live suite for the Moonshot Kimi agent (OpenAI-compatible chat completions, always-on
 * reasoning). Real calls; skips itself when MOONSHOT_API_KEY is missing. What it pins:
 * - schema asks return typed replies with token usage (JSON mode with prompt-schema fallback)
 * - a large 8-character structured response parses cleanly
 * - cache hits, when Moonshot reports them, surface as cachedInputTokens (a breakdown of
 *   inputTokens, never larger than it) — observed, not asserted, since hits aren't guaranteed
 * - provider errors surface as the agent's wrapped error
 */
import { KimiAgent } from './kimi-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import { validateResponse } from '../zod-validate';
import type { AIMessage } from '../types';
import { assistantPrompt, sampleHistory, ReplySchema, SceneSchema, SILENT_LOGGING } from '../testing/fixtures';

const apiKey = process.env[API_KEY_CONSTANTS.MOONSHOT];
const describeLive = apiKey ? describe : describe.skip;
const KIMI = SupportedAiModels[LLM_CONSTANTS.KIMI].modelApiName;

// Kimi K3 rejects any temperature but 1 and the agent never sends the field, so the value
// passed here is irrelevant; 0 mirrors how the factory constructs it.
const createAgent = (name: string): KimiAgent =>
    new KimiAgent(name, assistantPrompt({ name }), KIMI, apiKey || 'test_key', 0, true, SILENT_LOGGING);

describe('KimiAgent live', () => {
    describeLive('askWithZodSchema against the real API', () => {
        it('returns a typed reply with token usage', async () => {
            const agent = createAgent('Mira');
            const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

            expect(typeof response).toBe('object');
            expect(typeof response.reply).toBe('string');
            expect(response.reply.length).toBeGreaterThan(0);
            expect(typeof thinking).toBe('string');

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 60000);

        it('answers a one-line request in character', async () => {
            const agent = createAgent('Mira');
            const messages: AIMessage[] = [{ role: 'user', content: 'Introduce yourself to the party in one sentence. Reply as JSON.' }];
            const [response] = await agent.askWithZodSchema(ReplySchema, messages);
            expect(response.reply.length).toBeGreaterThan(0);
        }, 60000);

        it('surfaces cached input tokens as a breakdown of input tokens when Moonshot reports them', async () => {
            // Same prefix twice: the second call may hit Moonshot's automatic prompt cache.
            const agent = createAgent('Mira');
            const history = sampleHistory();
            await agent.askWithZodSchema(ReplySchema, history);
            const [, , usage] = await agent.askWithZodSchema(ReplySchema, history);

            expect(usage).toBeDefined();
            if (usage!.cachedInputTokens !== undefined) {
                expect(usage!.cachedInputTokens).toBeGreaterThanOrEqual(0);
                expect(usage!.cachedInputTokens).toBeLessThanOrEqual(usage!.inputTokens);
                console.log(`ℹ️ Kimi cache hit: ${usage!.cachedInputTokens}/${usage!.inputTokens} input tokens cached`);
            } else {
                console.log('ℹ️ Kimi reported no cached tokens on the second call');
            }
        }, 120000);

        it('generates an 8-character scene at a 16k output ceiling without truncating', async () => {
            const agent = createAgent('Narrator');
            agent.maxOutputTokens = 16384;
            const messages: AIMessage[] = [{
                role: 'user',
                content: 'Invent a scene in the ruined castle with exactly 8 characters. For each give a name, a role in the party, and one spoken line. Reply as JSON.',
            }];

            const [scene, , tokenUsage] = await agent.askWithZodSchema(SceneSchema, messages);

            expect(scene.title.length).toBeGreaterThan(0);
            expect(scene.characters).toHaveLength(8);
            for (const character of scene.characters) {
                expect(character.name.length).toBeGreaterThan(0);
                expect(character.line.length).toBeGreaterThan(0);
            }
            expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 180000);
    });

    describe('error handling', () => {
        it('wraps API errors in the agent error, not a schema error', async () => {
            const agent = new KimiAgent('Mira', 'Test instruction', KIMI, 'invalid_api_key', 0, true, SILENT_LOGGING);
            await expect(agent.askWithZodSchema(ReplySchema, [{ role: 'user', content: 'Test message' }]))
                .rejects.toThrow('Failed to get response from Kimi API');
        }, 30000);
    });

    describe('configuration', () => {
        it('targets a kimi model', () => {
            const agent = createAgent('Mira');
            expect((agent as any).client).toBeDefined();
            expect((agent as any).model).toContain('kimi');
        });
    });

    describe('validation helper', () => {
        it('accepts a matching object and rejects a mismatched one', () => {
            expect(validateResponse(ReplySchema, { reply: 'We should be careful past that door.' }).reply)
                .toBe('We should be careful past that door.');
            expect(() => validateResponse(ReplySchema, { message: 'wrong key' })).toThrow();
        });
    });
});
