/**
 * Live contract tests for GlmAgent (real Z.AI API calls — cost money, need Z_AI_API_KEY in
 * .env). Run with `npm run test:live -- src/agents/glm-agent.live`.
 *
 * What these pin: GLM-5.3 always reasons server-side and `enableThinking` only gates whether
 * reasoning_content is surfaced; both 5.3 and 5.3 Flash answer schema-validated asks with
 * usage and cost; a long structured generation parses without truncation; API failures are
 * wrapped as Z.AI errors. Mocked parsing/cost cases live in glm-agent.test.ts.
 */
import { GlmAgent } from './glm-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import {
    SILENT_LOGGING, liveApiKeys, assistantPrompt, sampleHistory, ReplySchema, SceneSchema,
} from '../testing/fixtures';

const apiKey = liveApiKeys()[API_KEY_CONSTANTS.Z_AI];
const describeLive = apiKey ? describe : describe.skip;

function makeAgent(modelId: string = LLM_CONSTANTS.GLM, enableThinking = false, key: string = apiKey!): GlmAgent {
    const config = SupportedAiModels[modelId];
    return new GlmAgent('Mira', assistantPrompt(), config.modelApiName, key, config.temperature ?? 0.7, enableThinking, SILENT_LOGGING);
}

describeLive('GlmAgent (live)', () => {
    it('GLM-5.3 answers a schema-validated ask; reasoning stays hidden when not surfaced', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GLM, false);
        const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);
        // The model always reasons; enableThinking=false means reasoning_content is not captured.
        expect(thinking).toBe('');

        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.costUSD).toBeGreaterThan(0);
    }, 60000);

    it('GLM-5.3 with thinking surfaced still returns a schema-valid reply', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GLM, true);
        const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);
        // The API may or may not return reasoning for a short prompt; the type is the contract.
        expect(typeof thinking).toBe('string');

        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
    }, 60000);

    it('GLM-5.3 Flash answers a schema-validated ask with cost', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GLM_FLASH, true);
        const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

        expect(typeof response.reply).toBe('string');
        expect(response.reply.length).toBeGreaterThan(0);
        expect(typeof thinking).toBe('string');

        expect(tokenUsage).toBeDefined();
        expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        expect(tokenUsage!.costUSD).toBeGreaterThan(0);
    }, 60000);

    it('GLM-5.3 generates an 8-character scene at a 16k output ceiling without truncating', async () => {
        const config = SupportedAiModels[LLM_CONSTANTS.GLM];
        const agent = new GlmAgent(
            'Narrator',
            'You are the narrator of a collaborative text adventure. When asked for JSON, reply with a single JSON object and nothing else.',
            config.modelApiName,
            apiKey!,
            config.temperature ?? 0.7,
            false,
            SILENT_LOGGING,
        );
        agent.maxOutputTokens = 16384;

        const [scene, , tokenUsage] = await agent.askWithZodSchema(SceneSchema, [{
            role: 'user',
            content: 'Write the opening scene of a mystery in a fog-shrouded harbor town. Introduce exactly 8 characters, each with a distinct role and a two-sentence opening line.',
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
        expect(tokenUsage!.costUSD).toBeGreaterThan(0);
    }, 180000);

    it('surfaces an API failure as a Z.AI error', async () => {
        const agent = makeAgent(LLM_CONSTANTS.GLM, false, 'invalid_key_for_z_ai');
        await expect(agent.askWithZodSchema(ReplySchema, [{ role: 'user', content: 'Hello' }]))
            .rejects
            .toThrow('Failed to get response from Z.AI API');
    }, 30000);
});
