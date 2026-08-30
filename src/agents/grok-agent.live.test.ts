/**
 * Live suite for the xAI Grok agent (Responses API, always-on reasoning). Real calls; skips
 * itself when GROK_API_KEY is missing. What it pins:
 * - every response carries encrypted reasoning items (4th tuple slot) for multi-turn replay
 * - replaying those items on the next turn is accepted by the API
 * - schema asks and a large 8-character structured response parse cleanly
 * - provider errors surface as the agent's wrapped error
 * - grok-4.6 pricing: base tier, cached-input discount, doubled rates past 200k
 */
import { GrokAgent } from './grok-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import { calculateGrokCost } from '../pricing/grok-pricing';
import { validateResponse } from '../zod-validate';
import type { AIMessage } from '../types';
import { assistantPrompt, sampleHistory, ReplySchema, SceneSchema, SILENT_LOGGING } from '../testing/fixtures';

const apiKey = process.env[API_KEY_CONSTANTS.GROK];
const describeLive = apiKey ? describe : describe.skip;
const GROK = SupportedAiModels[LLM_CONSTANTS.GROK].modelApiName;

const createAgent = (name: string, enableThinking: boolean = true): GrokAgent =>
    new GrokAgent(name, assistantPrompt({ name }), GROK, apiKey || 'test_key', 0.7, enableThinking, SILENT_LOGGING);

describe('GrokAgent live', () => {
    describeLive('askWithZodSchema against the real API', () => {
        it('returns a typed reply, token usage, and encrypted reasoning items', async () => {
            const agent = createAgent('Mira');
            const [response, thinking, tokenUsage, encryptedReasoning] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

            // Always-on reasoning: encrypted items must come back for multi-turn replay.
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
            expect(tokenUsage!.totalTokens).toBeGreaterThan(0);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 120000);

        it('replays encrypted reasoning across turns', async () => {
            const agent = createAgent('Mira');
            const firstTurn: AIMessage[] = [{ role: 'user', content: 'Introduce yourself to the party in one sentence.' }];

            const [firstReply, , , encryptedReasoning] = await agent.askText(firstTurn);
            expect(firstReply.length).toBeGreaterThan(0);
            expect(encryptedReasoning).toBeDefined();

            // Second turn: the assistant message goes back together with its encrypted reasoning.
            const secondTurn: AIMessage[] = [
                firstTurn[0],
                { role: 'assistant', content: firstReply, grokEncryptedReasoning: encryptedReasoning },
                { role: 'user', content: 'Now repeat your introduction word for word.' },
            ];
            const [secondReply] = await agent.askText(secondTurn);
            expect(secondReply.length).toBeGreaterThan(0);
        }, 240000);

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
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 120000);
    });

    describe('error handling', () => {
        it('wraps API errors in the agent error, not a schema error', async () => {
            const agent = new GrokAgent('Mira', 'Test instruction', GROK, 'invalid_api_key', 0.7, false, SILENT_LOGGING);
            await expect(agent.askWithZodSchema(ReplySchema, [{ role: 'user', content: 'Test message' }]))
                .rejects.toThrow('Failed to get response from Grok API');
        }, 30000);
    });

    describe('token cost (grok-4.6)', () => {
        it('bills the base tier below 200k: $2 in / $6 out per 1M', () => {
            expect(calculateGrokCost(GROK, 100_000, 100_000)).toBeCloseTo(0.8, 4);
        });

        it('discounts cached input tokens at $0.50 per 1M', () => {
            // 50k @ $2 + 50k @ $0.50 + 100k @ $6, per million
            expect(calculateGrokCost(GROK, 100_000, 100_000, 50_000)).toBeCloseTo(0.725, 4);
        });

        it('doubles rates for prompts at or above 200k tokens', () => {
            // 1M @ $4 + 1M @ $12
            expect(calculateGrokCost(GROK, 1_000_000, 1_000_000)).toBeCloseTo(16.0, 2);
        });
    });

    describe('validation helper', () => {
        it('accepts a matching object and rejects a mismatched one', () => {
            expect(validateResponse(ReplySchema, { reply: 'Hello from the castle.' }).reply).toBe('Hello from the castle.');
            expect(() => validateResponse(ReplySchema, { message: 'wrong key' })).toThrow();
        });
    });
});
