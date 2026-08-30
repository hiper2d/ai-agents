/**
 * Live suite for the Mistral agent (Mistral SDK chat.complete). Real calls; skips itself
 * when MISTRAL_API_KEY is missing. What it pins:
 * - schema asks return typed replies with token usage on a plain model (Medium) and on the
 *   reasoning model (Magistral) — in JSON mode Magistral surfaces NO thinking, by design
 *   (the schema goes into the message content, not responseFormat)
 * - Magistral's plain-text path returns its structured content array as text, with the
 *   reasoning trace observed (not asserted — traces vary)
 * - a large 8-character structured response parses cleanly on both models
 * - provider errors, empty choices, and missing content surface as the agent's own errors
 * - catalog pricing for Medium and Magistral
 */
import { MistralAgent } from './mistral-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels, calculateModelCost } from '../catalog';
import { validateResponse } from '../zod-validate';
import type { AIMessage } from '../types';
import { assistantPrompt, sampleHistory, ReplySchema, SceneSchema, SILENT_LOGGING } from '../testing/fixtures';

const apiKey = process.env[API_KEY_CONSTANTS.MISTRAL];
const describeLive = apiKey ? describe : describe.skip;

const createAgent = (name: string, modelType: string, enableThinking?: boolean): MistralAgent =>
    new MistralAgent(
        name,
        assistantPrompt({ name }),
        SupportedAiModels[modelType].modelApiName,
        apiKey || 'test_key',
        enableThinking ?? SupportedAiModels[modelType].hasThinking,
        SILENT_LOGGING,
    );

const SCENE_REQUEST: AIMessage[] = [{
    role: 'user',
    content: 'Invent a scene in the ruined castle with exactly 8 characters. For each give a name, a role in the party, and one spoken line. Reply as JSON.',
}];

describe('MistralAgent live', () => {
    describeLive('askWithZodSchema against the real API', () => {
        const expectTypedReply = async (modelType: string) => {
            const agent = createAgent('Mira', modelType);
            const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

            expect(typeof response).toBe('object');
            expect(typeof response.reply).toBe('string');
            expect(response.reply.length).toBeGreaterThan(0);
            // JSON mode never carries a reasoning trace, on either model.
            expect(thinking).toBe('');

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.totalTokens).toBeGreaterThan(0);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        };

        it('Mistral Medium returns a typed reply with token usage', async () => {
            await expectTypedReply(LLM_CONSTANTS.MISTRAL_3_5_MEDIUM);
        }, 30000);

        it('Magistral returns a typed reply in JSON mode with empty thinking (by design)', async () => {
            await expectTypedReply(LLM_CONSTANTS.MISTRAL_MAGISTRAL);
        }, 60000);

        it('Magistral still answers a step-by-step prompt in JSON mode', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_MAGISTRAL);
            const messages: AIMessage[] = [{
                role: 'user',
                content: 'Think step by step: the party had 3 torches and 1 burned out. How many remain? Reply as JSON.',
            }];
            const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, messages);

            expect(response.reply.length).toBeGreaterThan(0);
            expect(thinking).toBe('');
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 60000);

        it('Mistral Medium generates an 8-character scene at a 16k output ceiling without truncating', async () => {
            const agent = createAgent('Narrator', LLM_CONSTANTS.MISTRAL_3_5_MEDIUM, false);
            agent.maxOutputTokens = 16384;
            const [scene, , tokenUsage] = await agent.askWithZodSchema(SceneSchema, SCENE_REQUEST);

            expect(scene.title.length).toBeGreaterThan(0);
            expect(scene.characters).toHaveLength(8);
            for (const character of scene.characters) {
                expect(character.name.length).toBeGreaterThan(0);
                expect(character.line.length).toBeGreaterThan(0);
            }
            expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 90000);

        it('Magistral generates an 8-character scene in JSON mode (no thinking surfaced)', async () => {
            const agent = createAgent('Narrator', LLM_CONSTANTS.MISTRAL_MAGISTRAL, false);
            agent.maxOutputTokens = 16384;
            const [scene, thinking, tokenUsage] = await agent.askWithZodSchema(SceneSchema, SCENE_REQUEST);

            expect(scene.characters).toHaveLength(8);
            expect(thinking).toBe('');
            expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 120000);
    });

    describeLive('askText against the real API', () => {
        it('Magistral returns plain text from its structured content array, reasoning observed', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_MAGISTRAL);
            const [reply, thinking, tokenUsage] = await agent.askText([
                { role: 'user', content: 'Introduce yourself to the party in two sentences.' },
            ]);

            expect(typeof reply).toBe('string');
            expect(reply.trim().length).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
            // Magistral's trace is not guaranteed on short prompts — log, don't assert.
            console.log(`ℹ️ Magistral askText thinking: ${thinking.length > 0 ? `${thinking.length} chars` : 'not surfaced'}`);
        }, 60000);
    });

    describe('error handling', () => {
        const medium = SupportedAiModels[LLM_CONSTANTS.MISTRAL_3_5_MEDIUM].modelApiName;
        const ping: AIMessage[] = [{ role: 'user', content: 'Test message' }];

        it('wraps API errors in the agent error, not a schema error', async () => {
            const agent = new MistralAgent('Mira', 'Test instruction', medium, 'invalid_api_key', false, SILENT_LOGGING);
            await expect(agent.askWithZodSchema(ReplySchema, ping))
                .rejects.toThrow('Failed to get response from Mistral API');
        }, 30000);

        it('rejects a response with no choices', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_3_5_MEDIUM);
            (agent as any).client.chat.complete = jest.fn().mockResolvedValue({ choices: [] });
            await expect(agent.askWithZodSchema(ReplySchema, ping))
                .rejects.toThrow('Empty or undefined response from Mistral API');
        });

        it('rejects a choice with no content', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_3_5_MEDIUM);
            (agent as any).client.chat.complete = jest.fn().mockResolvedValue({ choices: [{ message: {} }] });
            await expect(agent.askWithZodSchema(ReplySchema, ping))
                .rejects.toThrow('Failed to get response from Mistral API: Invalid response format from Mistral API');
        });
    });

    describe('token cost', () => {
        it('Mistral Medium: $1.5 in / $7.5 out per 1M', () => {
            const apiName = SupportedAiModels[LLM_CONSTANTS.MISTRAL_3_5_MEDIUM].modelApiName;
            expect(calculateModelCost(apiName, 1_000_000, 1_000_000)).toBeCloseTo(9.0, 2);
        });

        it('Magistral Medium: $2 in / $5 out per 1M', () => {
            const apiName = SupportedAiModels[LLM_CONSTANTS.MISTRAL_MAGISTRAL].modelApiName;
            expect(calculateModelCost(apiName, 1_000_000, 1_000_000)).toBeCloseTo(7.0, 2);
        });
    });

    describe('validation helper', () => {
        it('accepts a matching object and rejects a mismatched one', () => {
            expect(validateResponse(ReplySchema, { reply: 'Hello from the castle.' }).reply).toBe('Hello from the castle.');
            expect(() => validateResponse(ReplySchema, { message: 'wrong key' })).toThrow();
        });
    });
});
