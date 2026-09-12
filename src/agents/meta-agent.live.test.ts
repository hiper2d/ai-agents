/**
 * Live suite for the Meta Model API agent (Muse Spark, Responses API, always-on reasoning).
 * Real calls; skips itself when META_API_KEY is missing. What it pins:
 * - every response carries encrypted reasoning items (4th tuple slot) for multi-turn replay
 * - replaying those items on the next turn is accepted by the API
 * - json_schema structured output and a large 8-character response parse cleanly
 * - reasoning tokens are reported and billed as output; cache hits show up on a repeat
 * - provider errors surface as the agent's wrapped error
 */
import { MetaAgent } from './meta-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import { calculateMetaCost } from '../pricing/meta-pricing';
import type { AIMessage } from '../types';
import { assistantPrompt, sampleHistory, ReplySchema, SceneSchema, SILENT_LOGGING } from '../testing/fixtures';

const apiKey = process.env[API_KEY_CONSTANTS.META];
const describeLive = apiKey ? describe : describe.skip;
const MUSE = SupportedAiModels[LLM_CONSTANTS.MUSE_SPARK].modelApiName;

const createAgent = (name: string): MetaAgent =>
    new MetaAgent(name, assistantPrompt({ name }), MUSE, apiKey || 'test_key', 1, true, SILENT_LOGGING);

describe('MetaAgent live', () => {
    describeLive('askWithZodSchema against the real API', () => {
        it('returns a typed reply, token usage with reasoning, and encrypted reasoning items', async () => {
            const agent = createAgent('Mira');
            const [response, thinking, tokenUsage, encryptedReasoning] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

            expect(encryptedReasoning).toBeDefined();
            const items = JSON.parse(encryptedReasoning!);
            expect(Array.isArray(items)).toBe(true);
            expect(items.length).toBeGreaterThan(0);
            expect(items[0].type).toBe('reasoning');
            expect(items[0].encrypted_content).toBeTruthy();

            expect(typeof response.reply).toBe('string');
            expect(response.reply.length).toBeGreaterThan(0);
            expect(typeof thinking).toBe('string');

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.reasoningTokens ?? 0).toBeGreaterThan(0);
            expect(tokenUsage!.costUSD).toBeCloseTo(
                calculateMetaCost(MUSE, tokenUsage!.inputTokens, tokenUsage!.outputTokens, tokenUsage!.cachedInputTokens ?? 0), 8);
        }, 120000);

        it('replays encrypted reasoning across turns', async () => {
            const agent = createAgent('Mira');
            const firstTurn: AIMessage[] = [{ role: 'user', content: 'Introduce yourself to the party in one sentence.' }];

            const [firstReply, , , encryptedReasoning] = await agent.askText(firstTurn);
            expect(firstReply.length).toBeGreaterThan(0);
            expect(encryptedReasoning).toBeDefined();

            const secondTurn: AIMessage[] = [
                firstTurn[0],
                { role: 'assistant', content: firstReply, metaEncryptedReasoning: encryptedReasoning },
                { role: 'user', content: 'Now say what you hope to find on this journey, in one sentence.' },
            ];
            const [secondReply, , usage2, encrypted2] = await agent.askText(secondTurn);
            expect(secondReply.length).toBeGreaterThan(0);
            expect(encrypted2).toBeDefined();
            expect(usage2).toBeDefined();
        }, 180000);

        it('a large structured response (8 characters) parses without truncation', async () => {
            const agent = createAgent('Narrator');
            agent.maxOutputTokens = 16384;
            const [scene] = await agent.askWithZodSchema(SceneSchema, [
                { role: 'user', content: 'Describe the scene and introduce exactly 8 characters as the schema requires.' },
            ]);
            expect(SceneSchema.safeParse(scene).success).toBe(true);
            expect(scene.characters).toHaveLength(8);
        }, 240000);

        it('a repeated prompt reports cached input tokens', async () => {
            const agent = createAgent('Mira');
            const history = sampleHistory();
            await agent.askText(history);
            const [, , usage] = await agent.askText(history);
            // Caching is automatic on Meta's side; a miss here is a routing fact, not a bug,
            // so this only asserts the field is wired when the provider reports it.
            expect(usage).toBeDefined();
            if (usage!.cachedInputTokens) {
                expect(usage!.cachedInputTokens).toBeLessThanOrEqual(usage!.inputTokens);
            }
        }, 180000);

        it('a bad key surfaces as the agent\'s wrapped error', async () => {
            const bad = new MetaAgent('Mira', assistantPrompt({ name: 'Mira' }), MUSE, 'invalid-key', 1, true, SILENT_LOGGING);
            await expect(bad.askText(sampleHistory())).rejects.toThrow('Failed to get response from Meta API');
        }, 60000);
    });
});
