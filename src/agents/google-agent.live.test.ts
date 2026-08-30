/**
 * Live contract tests for GoogleAgent (real Gemini API calls — cost money, need
 * GOOGLE_API_KEY in .env). Run with `npm run test:live -- src/agents/google-agent.live`.
 *
 * What these pin: schema-validated asks on Pro, Flash and Flash Lite with usage and cost
 * (every catalog id accepted, every pricing entry resolving), a long structured generation
 * that must not truncate, error wrapping, and the thinking contract — thought summaries +
 * signature surfaced when the model thinks, unsigned history replayed without crashing, and
 * a thinking block that lost its signature dropped instead of sent.
 */
import { GoogleAgent } from './google-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import type { AIMessage } from '../types';
import {
    SILENT_LOGGING, TEST_API_KEYS, liveApiKeys, assistantPrompt, sampleHistory,
    ReplySchema, SceneSchema,
} from '../testing/fixtures';

const apiKey = liveApiKeys()[API_KEY_CONSTANTS.GOOGLE];
const describeLive = apiKey ? describe : describe.skip;

const apiName = (id: string) => SupportedAiModels[id].modelApiName;

function makeAgent(modelId: string = LLM_CONSTANTS.GEMINI_PRO, enableThinking = false, key: string = apiKey!): GoogleAgent {
    return new GoogleAgent('Mira', assistantPrompt(), apiName(modelId), key, enableThinking, SILENT_LOGGING);
}

describe('GoogleAgent (offline)', () => {
    it('rejects an unsupported message role before calling the API', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GEMINI_PRO, false, TEST_API_KEYS[API_KEY_CONSTANTS.GOOGLE]!);
        const messages: AIMessage[] = [{ role: 'invalid_role' as any, content: 'Test message' }];
        await expect(agent.askWithZodSchema(ReplySchema, messages)).rejects.toThrow();
    });
});

describeLive('GoogleAgent (live)', () => {
    it('Pro answers a schema-validated ask with usage that accounts for reasoning', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GEMINI_PRO);
        const [response, , tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);

        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        // Gemini 3 Pro always reasons; thought tokens are billed as output and must not be lost
        // from the total (they either land in outputTokens or on top of input + output).
        expect(tokenUsage!.totalTokens).toBeGreaterThanOrEqual(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
    }, 60000);

    it('Flash answers a schema-validated ask', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GEMINI_FLASH);
        const [response] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);
    }, 60000);

    it('Flash Lite answers a schema-validated ask and its pricing entry resolves', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GEMINI_LITE);
        const [response, , tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);
        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.costUSD).toBeGreaterThan(0);
    }, 60000);

    it('bills a short request at a sane cost', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GEMINI_PRO);
        const [, , tokenUsage] = await agent.askWithZodSchema(ReplySchema, [{ role: 'user', content: 'Hello, how are you today?' }]);

        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        expect(tokenUsage!.costUSD).toBeLessThan(1);
    }, 60000);

    it('surfaces an API failure', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GEMINI_PRO, false, 'invalid_api_key');
        await expect(agent.askWithZodSchema(ReplySchema, sampleHistory())).rejects.toThrow();
    }, 30000);

    it('Pro generates an 8-character scene at a 16k output ceiling without truncating', async () => {
        const agent = new GoogleAgent(
            'Narrator',
            'You are the narrator of a collaborative text adventure. When asked for JSON, reply with a single JSON object and nothing else.',
            apiName(LLM_CONSTANTS.GEMINI_PRO),
            apiKey!,
            false,
            SILENT_LOGGING,
        );
        agent.maxOutputTokens = 16384;

        const [scene] = await agent.askWithZodSchema(SceneSchema, [{
            role: 'user',
            content: 'Write the opening scene of a mystery aboard an orbital research station after a critical malfunction. Introduce exactly 8 characters, each with a distinct role and a two-sentence opening line.',
        }]);

        expect(scene.title.length).toBeGreaterThan(0);
        expect(['calm', 'tense', 'eerie']).toContain(scene.mood);
        expect(scene.characters).toHaveLength(8);
        for (const character of scene.characters) {
            expect(character.name.length).toBeGreaterThan(0);
            expect(character.role.length).toBeGreaterThan(0);
            expect(character.line.length).toBeGreaterThan(10);
        }
    }, 180000);

    describe('thinking', () => {
        it('returns thought content with a signature when the model thinks', async () => {
            const agent = makeAgent(LLM_CONSTANTS.GEMINI_PRO, true);
            const [response, thinking, , signature] = await agent.askWithZodSchema(ReplySchema, [{
                role: 'user',
                content: 'What is 15 * 13? Explain your reasoning, then answer in character.',
            }]);

            expect(response.reply).toBeDefined();
            // Thought summaries can be empty when the model decides not to think; when present,
            // the signature must come with them (required to replay the thought on later turns).
            if (thinking && thinking.length > 0) {
                expect(signature).toBeDefined();
                expect(signature!.length).toBeGreaterThan(10);
            }
        }, 60000);

        it('replays a mixed history (unsigned text-only turn) without crashing', async () => {
            const agent = makeAgent(LLM_CONSTANTS.GEMINI_PRO, true);
            const messages: AIMessage[] = [
                { role: 'user', content: 'Hi, I am Alice.' },
                { role: 'assistant', content: 'Hello Alice. I am Mira.' }, // no thinking, no signature
                { role: 'user', content: "Calculate the square root of 144 and tell me if it's a prime number." },
            ];

            const [response] = await agent.askWithZodSchema(ReplySchema, messages);
            expect(response.reply).toBeDefined();
        }, 60000);

        it('drops a thinking block that lost its signature instead of sending it', async () => {
            const agent = makeAgent(LLM_CONSTANTS.GEMINI_PRO, true);
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
