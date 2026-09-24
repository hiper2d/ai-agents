/**
 * Live suite for the Mistral agent (Mistral SDK chat.complete). Real calls; skips itself
 * when MISTRAL_API_KEY is missing. What it pins:
 * - schema asks return typed replies with token usage AND a reasoning trace on both hybrid
 *   models (Small 4, Medium 3.5) — `reasoning_effort` rides in the wire body and the trace
 *   arrives as a `thinking` content chunk even with json_schema structured output
 * - a stored trace on a prior assistant turn is replayed as [thinking, text] chunks and the
 *   API accepts the shape
 * - a large 8-character structured response parses cleanly on both models
 * - provider errors, empty choices, and missing content surface as the agent's own errors
 * - catalog pricing for Medium and Small
 */
import { MistralAgent } from './mistral-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels, calculateModelCost, isHybridThinkingModel } from '../catalog';
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
        const expectTypedReplyWithTrace = async (modelType: string) => {
            const agent = createAgent('Mira', modelType);
            const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

            expect(typeof response).toBe('object');
            expect(typeof response.reply).toBe('string');
            expect(response.reply.length).toBeGreaterThan(0);
            // reasoning_effort: high — the thinking chunk arrives alongside json_schema output.
            expect(thinking.length).toBeGreaterThan(0);

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
            console.log(`ℹ️ ${modelType} schema ask: ${thinking.length} chars of thinking, ${tokenUsage!.outputTokens} output tokens, ${tokenUsage!.durationMs}ms`);
        };

        it('Mistral Small returns a typed reply with a reasoning trace', async () => {
            await expectTypedReplyWithTrace(LLM_CONSTANTS.MISTRAL_SMALL);
        }, 60000);

        it('Mistral Medium returns a typed reply with a reasoning trace', async () => {
            await expectTypedReplyWithTrace(LLM_CONSTANTS.MISTRAL_MEDIUM);
        }, 60000);

        it('replays a stored trace on a prior assistant turn as thinking chunks', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_SMALL);
            const history = sampleHistory();
            // First turn: capture a real trace.
            const [, firstThinking] = await agent.askWithZodSchema(ReplySchema, history.slice(0, 1));
            expect(firstThinking.length).toBeGreaterThan(0);

            // Second turn: the prior answer carries that trace; the API must accept the shape.
            const withTrace: AIMessage[] = [
                history[0],
                { ...history[1], thinking: firstThinking },
                history[2],
            ];
            const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, withTrace);
            expect(response.reply.length).toBeGreaterThan(0);
            expect(thinking.length).toBeGreaterThan(0);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 90000);

        it('Mistral Medium generates an 8-character scene at a 16k output ceiling without truncating', async () => {
            const agent = createAgent('Narrator', LLM_CONSTANTS.MISTRAL_MEDIUM);
            agent.maxOutputTokens = 16384;
            const [scene, thinking, tokenUsage] = await agent.askWithZodSchema(SceneSchema, SCENE_REQUEST);

            expect(scene.title.length).toBeGreaterThan(0);
            expect(scene.characters).toHaveLength(8);
            for (const character of scene.characters) {
                expect(character.name.length).toBeGreaterThan(0);
                expect(character.line.length).toBeGreaterThan(0);
            }
            expect(thinking.length).toBeGreaterThan(0);
            expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 120000);

        it('Mistral Small generates an 8-character scene with reasoning on', async () => {
            const agent = createAgent('Narrator', LLM_CONSTANTS.MISTRAL_SMALL);
            agent.maxOutputTokens = 16384;
            const [scene, thinking, tokenUsage] = await agent.askWithZodSchema(SceneSchema, SCENE_REQUEST);

            expect(scene.characters).toHaveLength(8);
            expect(thinking.length).toBeGreaterThan(0);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 120000);
    });

    describeLive('askText against the real API', () => {
        it('Mistral Small returns plain text from its [thinking, text] content array', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_SMALL);
            const [reply, thinking, tokenUsage] = await agent.askText([
                { role: 'user', content: 'Introduce yourself to the party in two sentences.' },
            ]);

            expect(typeof reply).toBe('string');
            expect(reply.trim().length).toBeGreaterThan(0);
            expect(reply).not.toMatch(/"type"\s*:\s*"thinking"/);
            expect(thinking.length).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 60000);
    });

    describe('error handling', () => {
        const medium = SupportedAiModels[LLM_CONSTANTS.MISTRAL_MEDIUM].modelApiName;
        const ping: AIMessage[] = [{ role: 'user', content: 'Test message' }];

        it('wraps API errors in the agent error, not a schema error', async () => {
            const agent = new MistralAgent('Mira', 'Test instruction', medium, 'invalid_api_key', false, SILENT_LOGGING);
            await expect(agent.askWithZodSchema(ReplySchema, ping))
                .rejects.toThrow('Failed to get response from Mistral API');
        }, 30000);

        it('rejects a response with no choices', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_MEDIUM);
            (agent as any).client.chat.complete = jest.fn().mockResolvedValue({ choices: [] });
            await expect(agent.askWithZodSchema(ReplySchema, ping))
                .rejects.toThrow('Empty or undefined response from Mistral API');
        });

        it('rejects a choice with no content', async () => {
            const agent = createAgent('Mira', LLM_CONSTANTS.MISTRAL_MEDIUM);
            (agent as any).client.chat.complete = jest.fn().mockResolvedValue({ choices: [{ message: {} }] });
            await expect(agent.askWithZodSchema(ReplySchema, ping))
                .rejects.toThrow('Failed to get response from Mistral API: Invalid response format from Mistral API');
        });
    });

    describe('catalog', () => {
        it('Mistral Medium: $1.5 in / $7.5 out per 1M', () => {
            const apiName = SupportedAiModels[LLM_CONSTANTS.MISTRAL_MEDIUM].modelApiName;
            expect(calculateModelCost(apiName, 1_000_000, 1_000_000)).toBeCloseTo(9.0, 2);
        });

        it('Mistral Small: $0.15 in / $0.6 out per 1M', () => {
            const apiName = SupportedAiModels[LLM_CONSTANTS.MISTRAL_SMALL].modelApiName;
            expect(calculateModelCost(apiName, 1_000_000, 1_000_000)).toBeCloseTo(0.75, 2);
        });

        it('both entries are hybrid thinking models pinned to high effort', () => {
            for (const id of [LLM_CONSTANTS.MISTRAL_MEDIUM, LLM_CONSTANTS.MISTRAL_SMALL]) {
                const config = SupportedAiModels[id];
                expect(config.hasThinking).toBe(true);
                expect(config.reasoningEffort).toBe('high');
                expect(isHybridThinkingModel(config.modelApiName)).toBe(true);
            }
        });
    });

    describe('validation helper', () => {
        it('accepts a matching object and rejects a mismatched one', () => {
            expect(validateResponse(ReplySchema, { reply: 'Hello from the castle.' }).reply).toBe('Hello from the castle.');
            expect(() => validateResponse(ReplySchema, { message: 'wrong key' })).toThrow();
        });
    });
});
