/**
 * Live contract tests for DeepSeekV2Agent (real DeepSeek API calls — cost money, need
 * DEEPSEEK_API_KEY in .env). Run with `npm run test:live -- src/agents/deepseek-v2-agent.live`.
 *
 * What these pin: with thinking on, reasoning_content is surfaced on both ask paths and
 * JSON mode still yields a schema-valid object; with thinking off, the (explicit, top-level)
 * disable flag actually reaches the API and no reasoning comes back; a long structured
 * generation parses without truncation and is billed with cost.
 */
import { DeepSeekV2Agent } from './deepseek-v2-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import {
    SILENT_LOGGING, liveApiKeys, assistantPrompt, sampleHistory, ReplySchema, SceneSchema,
} from '../testing/fixtures';

const apiKey = liveApiKeys()[API_KEY_CONSTANTS.DEEPSEEK];
const describeLive = apiKey ? describe : describe.skip;

const apiName = (id: string) => SupportedAiModels[id].modelApiName;

function makeAgent(modelId: string = LLM_CONSTANTS.DEEPSEEK_PRO, enableThinking = true): DeepSeekV2Agent {
    return new DeepSeekV2Agent('Mira', assistantPrompt(), apiName(modelId), apiKey!, 0.7, enableThinking, SILENT_LOGGING);
}

describeLive('DeepSeekV2Agent (live)', () => {
    describe('askWithZodSchema', () => {
        it('Pro with thinking returns a schema-valid reply, reasoning content and usage', async () => {
            const agent = makeAgent(LLM_CONSTANTS.DEEPSEEK_PRO, true);
            const [response, thinking, tokenUsage] = await agent.askWithZodSchema(ReplySchema, sampleHistory());

            expect(typeof response.reply).toBe('string');
            expect(response.reply.length).toBeGreaterThan(0);
            // Thinking mode surfaces reasoning_content
            expect(thinking.length).toBeGreaterThan(0);

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 120000);

        it('Flash generates an 8-character scene at a 16k output ceiling without truncating', async () => {
            const agent = new DeepSeekV2Agent(
                'Narrator',
                'You are the narrator of a collaborative text adventure. When asked for JSON, reply with a single JSON object and nothing else.',
                apiName(LLM_CONSTANTS.DEEPSEEK_FLASH),
                apiKey!,
                0.7,
                true,
                SILENT_LOGGING,
            );
            agent.maxOutputTokens = 16384;

            const [scene, thinking, tokenUsage] = await agent.askWithZodSchema(SceneSchema, [{
                role: 'user',
                content: 'Write the opening scene of a mystery aboard a deep-sea research station that has lost contact with the surface. Introduce exactly 8 characters, each with a distinct role and a two-sentence opening line.',
            }]);

            expect(scene.title.length).toBeGreaterThan(0);
            expect(['calm', 'tense', 'eerie']).toContain(scene.mood);
            expect(scene.characters).toHaveLength(8);
            for (const character of scene.characters) {
                expect(character.name.length).toBeGreaterThan(0);
                expect(character.role.length).toBeGreaterThan(0);
                expect(character.line.length).toBeGreaterThan(10);
            }
            expect(thinking.length).toBeGreaterThan(0);

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.totalTokens).toBe(tokenUsage!.inputTokens + tokenUsage!.outputTokens);
            expect(tokenUsage!.costUSD).toBeGreaterThan(0);
        }, 240000);
    });

    describe('askText', () => {
        it('with thinking returns plain prose (no JSON envelope) plus reasoning content', async () => {
            const agent = makeAgent(LLM_CONSTANTS.DEEPSEEK_PRO, true);
            const [reply, thinking, tokenUsage] = await agent.askText([{
                role: 'user',
                content: 'In 3-4 sentences, describe what you see as the party enters the ruined great hall.',
            }]);

            expect(typeof reply).toBe('string');
            expect(reply.length).toBeGreaterThan(0);
            expect(reply.trim().startsWith('{')).toBe(false);
            expect(thinking.length).toBeGreaterThan(0);

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 120000);

        it('with thinking disabled returns plain prose and no reasoning content', async () => {
            // DeepSeek V4 thinks by default; this proves the top-level `thinking: disabled`
            // flag reaches the API (the old extra_body form was silently ignored).
            const agent = makeAgent(LLM_CONSTANTS.DEEPSEEK_FLASH, false);
            const [reply, thinking, tokenUsage] = await agent.askText([{
                role: 'user',
                content: 'In 2-3 sentences, introduce yourself to the rest of the party.',
            }]);

            expect(typeof reply).toBe('string');
            expect(reply.length).toBeGreaterThan(0);
            expect(reply.trim().startsWith('{')).toBe(false);
            expect(thinking).toBe('');

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 120000);
    });
});
