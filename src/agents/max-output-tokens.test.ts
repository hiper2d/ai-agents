import * as fs from 'fs';
import * as path from 'path';
import { AgentFactory } from './agent-factory';
import {
    DEFAULT_MAX_OUTPUT_TOKENS,
    LLM_CONSTANTS,
    SupportedAiModels,
} from '../catalog';
import { TEST_API_KEYS } from '../testing/fixtures';

/** Every catalog model, so a newly added one is covered without editing this file. */
const ALL_MODEL_IDS = Object.keys(SupportedAiModels);

/** A per-call profile larger than a turn, the way a host raises it for long-form output. */
const LONG_FORM_MAX_OUTPUT_TOKENS = 16384;

describe('max output tokens', () => {
    it('resolves the shared default for models with no catalog override', () => {
        const agent = AgentFactory.createAgent('character', 'instruction', LLM_CONSTANTS.CLAUDE_4_HAIKU, TEST_API_KEYS);
        expect(SupportedAiModels[LLM_CONSTANTS.CLAUDE_4_HAIKU].maxOutputTokens).toBeUndefined();
        expect(agent.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it('prefers a catalog override where one is set', () => {
        const flash = SupportedAiModels[LLM_CONSTANTS.DEEPSEEK_V4_FLASH];
        expect(flash.maxOutputTokens).toBeDefined();
        const agent = AgentFactory.createAgent('character', 'instruction', LLM_CONSTANTS.DEEPSEEK_V4_FLASH, TEST_API_KEYS);
        expect(agent.maxOutputTokens).toBe(flash.maxOutputTokens);
    });

    it('gives every model a positive budget that leaves room for its thinking budget', () => {
        for (const id of ALL_MODEL_IDS) {
            const agent = AgentFactory.createAgent('character', 'instruction', id, TEST_API_KEYS);
            expect(agent.maxOutputTokens).toBeGreaterThan(0);
            // Providers bill reasoning inside the output budget, and Anthropic additionally
            // rejects budget_tokens >= max_tokens.
            const budget = SupportedAiModels[id].thinkingBudgetTokens;
            if (budget !== undefined) {
                expect(agent.maxOutputTokens).toBeGreaterThan(budget);
            }
        }
    });

    it('is mutable per agent, so one caller can raise it without affecting others', () => {
        const longForm = AgentFactory.createAgent('narrator', 'instruction', LLM_CONSTANTS.CLAUDE_4_HAIKU, TEST_API_KEYS);
        const turn = AgentFactory.createAgent('character', 'instruction', LLM_CONSTANTS.CLAUDE_4_HAIKU, TEST_API_KEYS);
        longForm.maxOutputTokens = LONG_FORM_MAX_OUTPUT_TOKENS;
        expect(longForm.maxOutputTokens).toBe(LONG_FORM_MAX_OUTPUT_TOKENS);
        expect(turn.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    /**
     * The regression this refactor exists to prevent: an agent that snapshots the cap into a
     * field initializer ignores a later override, so a long-form call would silently run at
     * the turn-sized default. Guard structurally — no agent may hardcode a token ceiling.
     */
    it('no agent hardcodes an output-token ceiling', () => {
        const dir = __dirname;
        const agentFiles = fs.readdirSync(dir).filter(f => f.endsWith('-agent.ts') && !f.includes('.test.'));
        expect(agentFiles.length).toBeGreaterThan(5);
        const offenders: string[] = [];
        for (const file of agentFiles) {
            const src = fs.readFileSync(path.join(dir, file), 'utf8');
            for (const line of src.split('\n')) {
                // A numeric literal assigned to any max-tokens-shaped key.
                if (/\b(max_tokens|maxTokens|max_output_tokens|maxOutputTokens|max_completion_tokens)\s*[:=]\s*\d+/.test(line)) {
                    offenders.push(`${file}: ${line.trim()}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('reasoning knobs (reasoningEffort / thinkingBudgetTokens)', () => {
    it('resolves both from the catalog entry at construction', () => {
        for (const id of ALL_MODEL_IDS) {
            const agent = AgentFactory.createAgent('character', 'instruction', id, TEST_API_KEYS);
            const config = SupportedAiModels[id];
            expect(agent.reasoningEffort).toBe(config.reasoningEffort);
            expect(agent.thinkingBudgetTokens).toBe(config.thinkingBudgetTokens);
        }
    });

    it('carries an effort pin where the catalog sets one, and none where it does not', () => {
        const deepseek = AgentFactory.createAgent('character', 'instruction', LLM_CONSTANTS.DEEPSEEK_V4_FLASH, TEST_API_KEYS);
        expect(deepseek.reasoningEffort).toBe('low');
        const qwen = AgentFactory.createAgent('character', 'instruction', LLM_CONSTANTS.QWEN_FLASH, TEST_API_KEYS);
        expect(qwen.reasoningEffort).toBeUndefined();
        expect(qwen.thinkingBudgetTokens).toBe(1024);
    });

    it('is mutable per agent, so one caller can deepen reasoning without affecting others', () => {
        const deep = AgentFactory.createAgent('narrator', 'instruction', LLM_CONSTANTS.DEEPSEEK_V4_FLASH, TEST_API_KEYS);
        const turn = AgentFactory.createAgent('character', 'instruction', LLM_CONSTANTS.DEEPSEEK_V4_FLASH, TEST_API_KEYS);
        deep.reasoningEffort = 'high';
        deep.thinkingBudgetTokens = 8192;
        expect(deep.reasoningEffort).toBe('high');
        expect(deep.thinkingBudgetTokens).toBe(8192);
        expect(turn.reasoningEffort).toBe('low');
        expect(turn.thinkingBudgetTokens).toBeUndefined();
    });
});
