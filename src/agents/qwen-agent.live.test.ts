/**
 * Live suite for the Qwen agent (QwenCloud OpenAI-compatible endpoint). Real calls; skips
 * itself when QWEN_API_KEY is missing. What it pins:
 * - strict `json_schema` structured output is accepted WITH thinking on and the reasoning
 *   trace still arrives, on both catalog models (qwen3.8-flash, qwen3.8-max). Until 0.15.0 we
 *   sent no response_format on the belief that thinking mode rejects it, and qwen3.8-flash
 *   once answered a werewolf vote in character prose instead of JSON
 * - a roleplay-heavy vote prompt comes back as the schema, every field present, on repeated
 *   asks to Flash (the model that slipped)
 * - optional nullable enums (the night-action shape) pass the strict schema
 * - a stored trace replayed on a prior assistant turn (preserve_thinking) works alongside
 *   json_schema
 */
import { z } from 'zod';
import { QwenAgent } from './qwen-agent';
import { API_KEY_CONSTANTS, LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import type { AIMessage } from '../types';
import { SILENT_LOGGING } from '../testing/fixtures';

const apiKey = process.env[API_KEY_CONSTANTS.QWEN];
const describeLive = apiKey ? describe : describe.skip;

const KNIGHT = 'You are Sir Lancelot, a proud knight at Camelot playing a game of werewolf. Stay fully in character: first person, dramatic and emotional. Never break character.';
const CANDIDATES = ['Morgana', 'Mordred', 'Paul'];

const VoteSchema = z.object({
    who: z.string().describe('The exact name of the player you are voting to eliminate, copied from the candidates list'),
    why: z.string().describe('Your reasoning for voting for this player (brief but convincing)'),
});

const NightActionSchema = z.object({
    target: z.string().describe('The exact name of the player to act on'),
    reasoning: z.string().describe('Reasoning for the choice'),
    action_type: z.enum(['protect', 'kill']).nullable().optional().describe("'protect' (default) or 'kill' (one-time ability)"),
    narrativeHint: z.string().nullable().optional().describe('OPTIONAL: one short atmospheric sentence, naming no player'),
});

// The production failure: a vote asked in character. The message itself never mentions JSON.
const VOTE_REQUEST: AIMessage[] = [{
    role: 'user',
    content: `Morgana opened with a taunt wrapped in a threat. Mordred kept silent. Paul defended Morgana twice. It is time to vote. Candidates: ${CANDIDATES.join(', ')}. Tell the court who you vote to eliminate and why.`,
}];

const createAgent = (modelType: string): QwenAgent =>
    new QwenAgent(
        'Lancelot',
        KNIGHT,
        SupportedAiModels[modelType].modelApiName,
        apiKey || 'test_key',
        SupportedAiModels[modelType].temperature ?? 0.7,
        true,
        SILENT_LOGGING,
    );

const expectVote = (vote: z.infer<typeof VoteSchema>) => {
    expect(CANDIDATES).toContain(vote.who);
    expect(vote.why.trim().length).toBeGreaterThan(0);
};

describe('QwenAgent live', () => {
    describeLive('structured output (strict json_schema) with thinking on', () => {
        for (const modelType of [LLM_CONSTANTS.QWEN_FLASH, LLM_CONSTANTS.QWEN_MAX]) {
            it(`${SupportedAiModels[modelType].displayName} returns a schema vote with a reasoning trace`, async () => {
                const [vote, thinking, tokenUsage] = await createAgent(modelType).askWithZodSchema(VoteSchema, VOTE_REQUEST);
                expectVote(vote);
                expect(thinking.length).toBeGreaterThan(0);
                expect(tokenUsage!.costUSD).toBeGreaterThan(0);
                console.log(`ℹ️ ${modelType} vote: ${vote.who}, ${thinking.length} chars of thinking, ${tokenUsage!.outputTokens} output tokens`);
            }, 90000);
        }

        it('Flash holds the schema across repeated in-character votes', async () => {
            const agent = createAgent(LLM_CONSTANTS.QWEN_FLASH);
            const results = await Promise.all([1, 2, 3].map(() => agent.askWithZodSchema(VoteSchema, VOTE_REQUEST)));
            for (const [vote] of results) expectVote(vote);
        }, 90000);

        it('accepts optional nullable enums (night-action shape)', async () => {
            const [action] = await createAgent(LLM_CONSTANTS.QWEN_FLASH).askWithZodSchema(NightActionSchema, [{
                role: 'user',
                content: `Night falls. You are the Doctor. Choose who to protect tonight: ${CANDIDATES.join(', ')}.`,
            }]);
            expect(CANDIDATES).toContain(action.target);
            expect(action.reasoning.length).toBeGreaterThan(0);
            if (action.action_type != null) expect(['protect', 'kill']).toContain(action.action_type);
        }, 90000);

        it('replays a stored trace on a prior assistant turn alongside json_schema', async () => {
            const agent = createAgent(LLM_CONSTANTS.QWEN_FLASH);
            const [firstVote, firstThinking] = await agent.askWithZodSchema(VoteSchema, VOTE_REQUEST);
            expect(firstThinking.length).toBeGreaterThan(0);

            const history: AIMessage[] = [
                ...VOTE_REQUEST,
                { role: 'assistant', content: JSON.stringify(firstVote), thinking: firstThinking },
                { role: 'user', content: `${firstVote.who} survived the vote. A revote is called with the same candidates. Who now, and why?` },
            ];
            const [vote, thinking] = await agent.askWithZodSchema(VoteSchema, history);
            expectVote(vote);
            expect(thinking.length).toBeGreaterThan(0);
        }, 120000);
    });
});
