/**
 * Live suite for the OpenAI GPT-5 agent (Responses API, structured outputs). Real calls;
 * skips itself when OPENAI_API_KEY is missing. What it pins:
 * - schema-validated asks return typed objects plus full token usage (incl. cost)
 * - a large structured response (8 characters) parses without truncation at 16k output
 * - provider errors surface as the agent's wrapped error, never as a schema error
 * - Luna's extended-context pricing kicks in past its threshold
 */
import { Gpt5Agent } from './gpt-5-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels, MODEL_PRICING } from '../catalog';
import { calculateOpenAICost } from '../pricing/openai-pricing';
import { validateResponse } from '../zod-validate';
import type { AIMessage } from '../types';
import { assistantPrompt, sampleHistory, ReplySchema, SceneSchema, SILENT_LOGGING } from '../testing/fixtures';

const apiKey = process.env[API_KEY_CONSTANTS.OPENAI];
const describeLive = apiKey ? describe : describe.skip;

const createAgent = (
    name: string,
    modelType: string = LLM_CONSTANTS.GPT_MINI,
    enableThinking: boolean = true,
): Gpt5Agent =>
    new Gpt5Agent(
        name,
        assistantPrompt({ name }),
        SupportedAiModels[modelType].modelApiName,
        apiKey || 'test_key',
        0.7,
        enableThinking,
        SILENT_LOGGING,
    );

describe('Gpt5Agent live', () => {
    describeLive('askWithZodSchema against the real API', () => {
        it('returns a schema-typed reply with token usage (reasoning on)', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.GPT_MINI, true);
            const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

            expect(typeof response).toBe('object');
            expect(typeof response.reply).toBe('string');
            expect(response.reply.length).toBeGreaterThan(0);
            expect(typeof thinking).toBe('string');

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.totalTokens).toBeGreaterThan(0);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 60000);

        it('generates an 8-character scene at a 16k output ceiling without truncating', async () => {
            const agent = createAgent('Narrator', LLM_CONSTANTS.GPT_MINI, false);
            agent.maxOutputTokens = 16384;
            const messages: AIMessage[] = [{
                role: 'user',
                content: 'Invent a scene in the ruined castle with exactly 8 characters. For each give a name, a role in the party, and one spoken line. Reply as JSON.',
            }];

            const [scene, , tokenUsage] = await agent.askWithZodSchema(SceneSchema, messages);

            expect(scene.title.length).toBeGreaterThan(0);
            expect(['calm', 'tense', 'eerie']).toContain(scene.mood);
            expect(scene.characters).toHaveLength(8);
            for (const character of scene.characters) {
                expect(character.name.length).toBeGreaterThan(0);
                expect(character.role.length).toBeGreaterThan(0);
                expect(character.line.length).toBeGreaterThan(0);
            }
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 90000);
    });

    describe('error handling', () => {
        it('wraps API errors in the agent error, not a schema error', async () => {
            const agent = new Gpt5Agent(
                'Mira', 'Test instruction', SupportedAiModels[LLM_CONSTANTS.GPT_MINI].modelApiName,
                'invalid_api_key', 0.7, false, SILENT_LOGGING,
            );
            await expect(agent.askWithZodSchema(ReplySchema, [{ role: 'user', content: 'Test message' }]))
                .rejects.toThrow('Failed to get response from OpenAI API');
        }, 30000);
    });

    describe('token cost', () => {
        it('bills Luna at extended-context rates past its threshold', () => {
            const apiName = SupportedAiModels[LLM_CONSTANTS.GPT_MINI].modelApiName;
            const pricing = MODEL_PRICING[apiName];
            expect(pricing).toBeDefined();
            expect(pricing.extendedContextThresholdTokens).toBeLessThan(1_000_000);

            // 1M input exceeds the threshold, so both input and output use the extended rates.
            const cost = calculateOpenAICost(apiName, 1_000_000, 1_000_000);
            const expectedInput = pricing.extendedContextInputPrice ?? pricing.inputPrice;
            const expectedOutput = pricing.extendedContextOutputPrice ?? pricing.outputPrice;
            expect(cost).toBeCloseTo(expectedInput + expectedOutput, 2);
        });
    });

    describe('validation helper', () => {
        it('accepts a matching object and rejects a mismatched one', () => {
            expect(validateResponse(ReplySchema, { reply: 'Hello from the castle.' }).reply).toBe('Hello from the castle.');
            expect(() => validateResponse(ReplySchema, { message: 'wrong key' })).toThrow();
        });
    });
});
