/**
 * Live contract tests for ClaudeAgent (real Anthropic API calls — cost money, need
 * ANTHROPIC_API_KEY in .env). Run with `npm run test:live -- src/agents/anthropic-agent.live`.
 *
 * What these pin: schema-validated JSON asks on Sonnet and Opus, a long structured
 * generation that must not truncate, error wrapping, and the thinking contract —
 * reasoning + signature surfaced when the model thinks, mixed (unsigned) history replayed
 * without crashing, and a thinking block that lost its signature dropped instead of sent.
 */
import { ClaudeAgent } from './anthropic-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import type { AIMessage } from '../types';
import {
    SILENT_LOGGING, TEST_API_KEYS, liveApiKeys, assistantPrompt, sampleHistory,
    ReplySchema, SceneSchema,
} from '../testing/fixtures';

const apiKey = liveApiKeys()[API_KEY_CONSTANTS.ANTHROPIC];
const describeLive = apiKey ? describe : describe.skip;

const apiName = (id: string) => SupportedAiModels[id].modelApiName;

function makeAgent(modelId: string = LLM_CONSTANTS.CLAUDE_4_SONNET, enableThinking = false, key: string = apiKey!): ClaudeAgent {
    return new ClaudeAgent('Mira', assistantPrompt(), apiName(modelId), key, enableThinking, SILENT_LOGGING);
}

describe('ClaudeAgent (offline)', () => {
    it('rejects an unsupported message role before calling the API', async () => {
        // Role conversion fails first; the agent wraps every failure in its generic message,
        // the original cause lives in the error details.
        const agent = makeAgent(LLM_CONSTANTS.CLAUDE_4_SONNET, false, TEST_API_KEYS[API_KEY_CONSTANTS.ANTHROPIC]!);
        const messages: AIMessage[] = [{ role: 'invalid_role' as any, content: 'Test message' }];
        await expect(agent.askWithZodSchema(ReplySchema, messages))
            .rejects
            .toThrow('Failed to get response from Anthropic API with Zod schema');
    });
});

describeLive('ClaudeAgent (live)', () => {
    it('Sonnet answers a schema-validated ask with token usage', async () => {
        const agent = makeAgent(LLM_CONSTANTS.CLAUDE_4_SONNET);
        const [response, , tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);
        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
    }, 60000);

    it('Opus answers a schema-validated ask', async () => {
        const agent = makeAgent(LLM_CONSTANTS.CLAUDE_4_OPUS);
        const [response] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);
    }, 60000);

    it('surfaces an API failure as an Anthropic error', async () => {
        const agent = makeAgent(LLM_CONSTANTS.CLAUDE_4_SONNET, false, 'invalid_api_key');
        await expect(agent.askWithZodSchema(ReplySchema, [{ role: 'user', content: 'Test message' }]))
            .rejects
            .toThrow('Failed to get response from Anthropic API');
    }, 30000);

    it('generates an 8-character scene at a 16k output ceiling without truncating', async () => {
        const agent = new ClaudeAgent(
            'Narrator',
            'You are the narrator of a collaborative text adventure. When asked for JSON, reply with a single JSON object and nothing else.',
            apiName(LLM_CONSTANTS.CLAUDE_4_SONNET),
            apiKey!,
            false,
            SILENT_LOGGING,
        );
        agent.maxOutputTokens = 16384;

        const [scene, , tokenUsage] = await agent.askWithZodSchema(SceneSchema, [{
            role: 'user',
            content: 'Write the opening scene of a mystery set in a snowbound mountain observatory. Introduce exactly 8 characters, each with a distinct role and a two-sentence opening line.',
        }]);

        expect(scene.title.length).toBeGreaterThan(0);
        expect(['calm', 'tense', 'eerie']).toContain(scene.mood);
        expect(scene.characters).toHaveLength(8);
        for (const character of scene.characters) {
            expect(character.name.length).toBeGreaterThan(0);
            expect(character.role.length).toBeGreaterThan(0);
            expect(character.line.length).toBeGreaterThan(10);
        }

        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
        expect(tokenUsage!.costUSD).toBeGreaterThan(0);
    }, 120000);

    describe('thinking', () => {
        // Adaptive-thinking models decide per request; on a trivial prompt they may not think
        // at all, so reasoning is asserted only when present — but when it is, it must carry
        // a signature (required to replay it on later turns).
        it('returns reasoning with a signature when the model thinks', async () => {
            const agent = makeAgent(LLM_CONSTANTS.CLAUDE_4_SONNET, true);
            const [response, thinking, , signature] = await agent.askWithZodSchema(ReplySchema, [{
                role: 'user',
                content: 'What is 15 * 13? Explain your reasoning, then answer in character.',
            }]);

            expect(response.reply).toBeDefined();
            if (thinking && thinking.length > 0) {
                expect(signature).toBeDefined();
                expect(signature!.length).toBeGreaterThan(10);
            }
        }, 60000);

        it('replays a mixed history (unsigned text-only turn) without crashing', async () => {
            // Simulates a conversation that started on a non-thinking model.
            const agent = makeAgent(LLM_CONSTANTS.CLAUDE_4_SONNET, true);
            const messages: AIMessage[] = [
                { role: 'user', content: 'Hi, I am Alice.' },
                { role: 'assistant', content: 'Hello Alice.' }, // no thinking, no signature
                { role: 'user', content: 'What is my name?' },
            ];

            const [response, thinking, , signature] = await agent.askWithZodSchema(ReplySchema, messages);
            expect(response.reply).toBeDefined();
            if (thinking) {
                expect(signature).toBeDefined();
            }
        }, 60000);

        it('drops a thinking block that lost its signature instead of sending it', async () => {
            // A stored turn with reasoning text but no signature would be rejected by the API;
            // the agent must downgrade it to text-only.
            const agent = makeAgent(LLM_CONSTANTS.CLAUDE_4_SONNET, true);
            const messages: AIMessage[] = [
                { role: 'user', content: 'Analyze this.' },
                { role: 'assistant', content: 'I have analyzed it.', thinking: 'A thought that lost its signature.' },
                { role: 'user', content: 'What was your conclusion?' },
            ];

            const [response] = await agent.askWithZodSchema(ReplySchema, messages);
            expect(response.reply).toBeDefined();
        }, 60000);
    });
});
