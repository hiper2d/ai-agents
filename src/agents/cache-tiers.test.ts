/**
 * Pins the prompt-cache plumbing:
 * - CACHE_TIER_MARKER splits an instruction into tiers in AbstractAgent
 * - ClaudeAgent emits one cacheable system block per tier and anchors its fast
 *   breakpoint on the second-to-last message (never on the throwaway tail)
 * - the default prepareMessages merges consecutive user messages back together
 *   for providers that expect alternating roles; ClaudeAgent keeps them separate
 * - the fixture prompt's shared tier is byte-identical across characters (no placeholders)
 */
import { ClaudeAgent } from './anthropic-agent';
import { DeepSeekV2Agent } from './deepseek-v2-agent';
import { CACHE_TIER_MARKER } from '../cache-tier';
import { AIMessage } from '../types';
import { ASSISTANT_SYSTEM_PROMPT, assistantPrompt } from '../testing/fixtures';

describe('prompt cache tiers', () => {
    it('the fixture prompt keeps all placeholders below the cache tier marker', () => {
        const [sharedTier, ...rest] = ASSISTANT_SYSTEM_PROMPT.split(CACHE_TIER_MARKER);
        expect(rest.length).toBe(1); // exactly one marker
        expect(sharedTier).not.toMatch(/%\w+%/); // shared tier is character-independent
        expect(rest[0]).toMatch(/%name%/);
        expect(rest[0]).toMatch(/%background%/);
    });

    it('the shared tier is byte-identical across differently formatted characters', () => {
        const promptA = assistantPrompt();
        const promptB = assistantPrompt({ name: 'Orin', background: 'a disgraced knight' });
        expect(promptA.split(CACHE_TIER_MARKER)[0]).toBe(promptB.split(CACHE_TIER_MARKER)[0]);
        expect(promptA.split(CACHE_TIER_MARKER)[1]).not.toBe(promptB.split(CACHE_TIER_MARKER)[1]);
    });

    it('ClaudeAgent emits one cacheable system block per tier', () => {
        const agent = new ClaudeAgent('Mira', assistantPrompt(), 'claude-sonnet-5', 'test-key');
        const system = (agent as any).defaultParams.system;
        expect(system).toHaveLength(2);
        for (const block of system) {
            expect(block.type).toBe('text');
            expect(block.cache_control).toEqual({ type: 'ephemeral' });
            expect(block.text).not.toContain('CACHE_TIER_BREAK');
        }
        expect(system[0].text).toContain('collaborative text adventure');
        expect(system[1].text).toContain('Mira');
    });

    it('ClaudeAgent falls back to a single system block for marker-free prompts', () => {
        const agent = new ClaudeAgent('Narrator', 'You are the narrator.', 'claude-sonnet-5', 'test-key');
        const system = (agent as any).defaultParams.system;
        expect(system).toHaveLength(1);
        expect(system[0].text).toBe('You are the narrator.');
    });

    it('ClaudeAgent anchors the fast breakpoint one position back, not on the tail', () => {
        const agent = new ClaudeAgent('Mira', 'instruction', 'claude-sonnet-5', 'test-key');
        const messages = [
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'current prompt' },
            { role: 'user', content: 'throwaway reminder' },
        ];
        (agent as any).applyCacheBreakpoint(messages);
        expect(messages[2].content).toEqual([
            { type: 'text', text: 'current prompt', cache_control: { type: 'ephemeral' } },
        ]);
        expect(typeof messages[3].content).toBe('string'); // tail untouched
    });

    it('ClaudeAgent reconstructs full prompt size from cache fields and bills hits at the cached rate', () => {
        const agent = new ClaudeAgent('Mira', 'instruction', 'claude-sonnet-5', 'test-key');
        // Anthropic's input_tokens EXCLUDES cached tokens: total prompt = 100 + 4000 + 500.
        const usage = (agent as any).buildTokenUsage({
            input_tokens: 100,
            output_tokens: 200,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: 500,
        });
        expect(usage.inputTokens).toBe(4600);
        expect(usage.outputTokens).toBe(200);
        expect(usage.totalTokens).toBe(4800);
        // Sonnet 5: $2/M input, $10/M output, $0.20/M cached.
        // (600 uncached+written) * 2 + 4000 cached * 0.20 + 200 out * 10, per million.
        const expected = (600 * 2.0 + 4000 * 0.20 + 200 * 10.0) / 1_000_000;
        expect(usage.costUSD).toBeCloseTo(expected, 10);
    });

    it('default prepareMessages merges consecutive user messages; ClaudeAgent keeps them apart', () => {
        const history: AIMessage[] = [
            { role: 'assistant', content: 'earlier reply' },
            { role: 'user', content: 'narrator prompt' },
            { role: 'user', content: 'reminder' },
        ];
        const deepseek = new DeepSeekV2Agent('Mira', 'instruction', 'deepseek-v4-flash', 'test-key', 0.6);
        const merged = (deepseek as any).prepareMessages(history);
        expect(merged).toHaveLength(2);
        expect(merged[1].content).toBe('narrator prompt\n\nreminder');

        const claude = new ClaudeAgent('Mira', 'instruction', 'claude-sonnet-5', 'test-key');
        const kept = (claude as any).prepareMessages(history);
        expect(kept).toHaveLength(3);
    });
});
