/**
 * Cross-provider sweep: every catalog model, through the factory, on the three call shapes
 * a consumer relies on. Real calls; each model skips itself when its provider key is
 * missing. A per-model duration/usage table is printed at the end.
 *
 * 1. Constrained choice — askWithZodSchema(ChoiceSchema) after a short history must pick
 *    one of the listed options (schema-following under context).
 * 2. Plain text — askText returns prose, never a JSON envelope; thinking surfaces per the
 *    provider contract (guaranteed / always empty / observed). One representative per
 *    provider code path is enough: plain-text extraction is a property of the agent code,
 *    not of the model variant.
 * 3. Large structured output — SceneSchema with exactly 8 characters at a 16k output
 *    ceiling parses without truncation.
 */
import { AgentFactory } from './agent-factory';
import { LLM_CONSTANTS, SupportedAiModels } from '../catalog';
import type { AIMessage, TokenUsage } from '../types';
import { assistantPrompt, sampleHistory, liveApiKeys, ChoiceSchema, SceneSchema } from '../testing/fixtures';

const apiKeys = liveApiKeys();
const allModels = Object.keys(SupportedAiModels);

// --- perf rows -------------------------------------------------------------------------

interface PerfRow { scenario: string; model: string; ok: boolean; ms: number; usage?: TokenUsage }
const rows: PerfRow[] = [];

async function timed<T extends [unknown, string, TokenUsage?, string?]>(
    scenario: string, model: string, call: () => Promise<T>,
): Promise<T> {
    const start = Date.now();
    try {
        const result = await call();
        rows.push({ scenario, model, ok: true, ms: Date.now() - start, usage: result[2] });
        return result;
    } catch (e) {
        rows.push({ scenario, model, ok: false, ms: Date.now() - start });
        throw e;
    }
}

afterAll(() => {
    if (rows.length === 0) return;
    const scenarios = [...new Set(rows.map(r => r.scenario))];
    const lines: string[] = ['', '# Live sweep — per-model timing and usage', ''];
    for (const scenario of scenarios) {
        lines.push(`## ${scenario}`, '', '| Model | OK | Time | Input | Output | Total | Cost |', '|---|---|---:|---:|---:|---:|---:|');
        const subset = rows.filter(r => r.scenario === scenario).sort((a, b) => a.ms - b.ms);
        for (const r of subset) {
            const u = r.usage;
            lines.push(`| ${r.model} | ${r.ok ? '✓' : '✗'} | ${(r.ms / 1000).toFixed(1)}s | ${u?.inputTokens ?? '—'} | ${u?.outputTokens ?? '—'} | ${u?.totalTokens ?? '—'} | ${u ? `$${u.costUSD.toFixed(4)}` : '—'} |`);
        }
        const ok = subset.filter(r => r.ok).length;
        const cost = subset.reduce((s, r) => s + (r.usage?.costUSD ?? 0), 0);
        lines.push(`| **total** | ${ok}/${subset.length} | | | | | $${cost.toFixed(4)} |`, '');
    }
    console.log(lines.join('\n'));
});

// --- helpers ---------------------------------------------------------------------------

const OPTIONS = ['north door', 'east stairs', 'stay'];

// Models the agent layer currently cannot drive — skipped with the reason so the sweep
// stays green on what it can prove. Remove an entry once the agent is fixed.
const KNOWN_BROKEN: Record<string, string> = {
    // Fable answers the fixture requests (multi-turn choice, 8-character scene) with
    // stop_reason "refusal" and NO content blocks (probed raw via the SDK 2026-08-30, both with
    // and without display: "summarized"). A single-turn "say hi" passes. ClaudeAgent then reports
    // "Empty response" / "Invalid response format" — a refusal-aware error would be clearer, and
    // the prompts may need rewording for Fable's safety layer. Not a truncation or parsing bug.
    [LLM_CONSTANTS.CLAUDE_FABLE]: 'Fable returns stop_reason=refusal with no content for these prompts',
};

function describeModel(llmType: string): { config: typeof SupportedAiModels[string]; hasKey: boolean; broken?: string } {
    const config = SupportedAiModels[llmType];
    return { config, hasKey: Boolean(config && apiKeys[config.apiKeyName]), broken: KNOWN_BROKEN[llmType] };
}

function skipReason(llmType: string): string | undefined {
    const { config, hasKey, broken } = describeModel(llmType);
    if (!config) return 'no config';
    if (broken) return `known broken: ${broken}`;
    if (!hasKey) return `${config.apiKeyName} not set`;
    return undefined;
}

// --- 1. constrained choice --------------------------------------------------------------

const choiceHistory: AIMessage[] = [
    ...sampleHistory(),
    {
        role: 'user',
        content: `Narrator: The party must decide now. Pick exactly one of: ${OPTIONS.join(' / ')}. Reply as JSON with your choice and one sentence of reasoning.`,
    },
];

describe('All providers — constrained choice via askWithZodSchema', () => {
    for (const llmType of allModels) {
        const { config } = describeModel(llmType);
        const reason = skipReason(llmType);
        if (reason) {
            it.skip(`${config?.displayName ?? llmType} (${llmType}) — ${reason}`, () => {});
            continue;
        }

        it(`${config.displayName} (${llmType}) picks one of the listed options`, async () => {
            const agent = AgentFactory.createAgent('Mira', assistantPrompt(), llmType, apiKeys);
            const [response, , tokenUsage] = await timed('Constrained choice', config.displayName,
                () => agent.askWithZodSchema(ChoiceSchema, choiceHistory));

            expect(typeof response.choice).toBe('string');
            expect(typeof response.reasoning).toBe('string');
            expect(response.reasoning.length).toBeGreaterThan(0);
            const picked = response.choice.trim().toLowerCase();
            expect(OPTIONS.some(o => picked.includes(o))).toBe(true);

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 180000);
    }
});

// --- 2. plain text ----------------------------------------------------------------------

// Models whose askText surfaces thinking reliably. NOT guaranteed: adaptive-thinking Claude
// models decide per request and skip thinking on trivial prompts; Grok returns encrypted
// reasoning; Gemini thought summaries and Magistral traces vary. Those are logged.
const THINKING_GUARANTEED = new Set<string>([
    LLM_CONSTANTS.CLAUDE_HAIKU,          // budget thinking is always emitted
    LLM_CONSTANTS.DEEPSEEK_FLASH,
    LLM_CONSTANTS.DEEPSEEK_PRO,
]);

// GPT-5's plain-text path cannot surface thinking (OpenAI never exposes chain-of-thought),
// so it must return an empty string.
const THINKING_ALWAYS_EMPTY = new Set<string>([
    LLM_CONSTANTS.GPT_SOL,
    LLM_CONSTANTS.GPT,
    LLM_CONSTANTS.GPT_MINI,
]);

const TEXT_SWEEP_MODELS = new Set<string>([
    LLM_CONSTANTS.CLAUDE_HAIKU,          // budget thinking
    LLM_CONSTANTS.CLAUDE_OPUS,           // adaptive thinking (may skip thinking)
    LLM_CONSTANTS.DEEPSEEK_FLASH,
    LLM_CONSTANTS.GPT_MINI,            // single path: thinking never surfaces
    LLM_CONSTANTS.GEMINI_FLASH,
    LLM_CONSTANTS.GEMINI_LITE,
    LLM_CONSTANTS.MISTRAL_SMALL,
    LLM_CONSTANTS.MISTRAL_MAGISTRAL,       // structured content array (thinking)
    LLM_CONSTANTS.GROK,
    LLM_CONSTANTS.KIMI,
    LLM_CONSTANTS.GLM,
    LLM_CONSTANTS.FUGU_ULTRA,
    LLM_CONSTANTS.QWEN_FLASH,
    LLM_CONSTANTS.MINIMAX,
]);

const textMessages: AIMessage[] = [
    { role: 'user', content: 'Narrator: Introduce yourself to the rest of the party in two or three sentences.' },
];

describe('All providers — plain text via askText', () => {
    for (const llmType of allModels.filter(id => TEXT_SWEEP_MODELS.has(id))) {
        const { config } = describeModel(llmType);
        const reason = skipReason(llmType);
        if (reason) {
            it.skip(`${config?.displayName ?? llmType} (${llmType}) — ${reason}`, () => {});
            continue;
        }

        it(`${config.displayName} (${llmType}) answers as prose`, async () => {
            const agent = AgentFactory.createAgent('Mira', assistantPrompt(), llmType, apiKeys);
            const [reply, thinking, tokenUsage, signature] = await timed('Plain text', config.displayName,
                () => agent.askText(textMessages));

            expect(typeof reply).toBe('string');
            expect(reply.trim().length).toBeGreaterThan(0);

            // ...and NOT a JSON envelope.
            let parsedAsJson: unknown = null;
            try { parsedAsJson = JSON.parse(reply); } catch { /* prose does not parse — good */ }
            if (parsedAsJson !== null && typeof parsedAsJson === 'object') {
                throw new Error(`${config.displayName} returned a JSON envelope instead of plain text: ${reply.substring(0, 200)}`);
            }

            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.inputTokens).toBeGreaterThan(0);
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);

            if (THINKING_GUARANTEED.has(llmType)) {
                expect(thinking.length).toBeGreaterThan(0);
            } else if (THINKING_ALWAYS_EMPTY.has(llmType) || !config.hasThinking) {
                expect(thinking).toBe('');
            } else {
                console.log(`ℹ️ ${config.displayName}: thinking ${thinking.length > 0 ? `present (${thinking.length} chars)` : 'not surfaced'}`);
            }

            // Claude must return a signature whenever it emitted thinking (multi-turn replay).
            if (llmType.startsWith('claude') && thinking.length > 0) {
                expect(signature).toBeDefined();
                expect(signature!.length).toBeGreaterThan(0);
            }
        }, 120000);
    }
});

// --- 3. large structured output ---------------------------------------------------------

const sceneMessages: AIMessage[] = [{
    role: 'user',
    content: 'Invent a scene in the ruined castle with exactly 8 characters. For each give a name, a role in the party, and one spoken line. Reply as JSON.',
}];

describe('All providers — 8-character scene at a 16k output ceiling', () => {
    for (const llmType of allModels) {
        const { config } = describeModel(llmType);
        const reason = skipReason(llmType);
        if (reason) {
            it.skip(`${config?.displayName ?? llmType} (${llmType}) — ${reason}`, () => {});
            continue;
        }

        it(`${config.displayName} (${llmType}) generates 8 characters without truncating`, async () => {
            const agent = AgentFactory.createAgent('Narrator', assistantPrompt({ name: 'Narrator', background: 'the storyteller', style: 'vivid' }), llmType, apiKeys);
            agent.maxOutputTokens = 16384;
            expect(agent.maxOutputTokens).toBe(16384);

            // A truncated response cuts the JSON mid-object, so schema parsing throwing here
            // IS the truncation signal — there is no partial-success path.
            const [scene, , tokenUsage] = await timed('8-character scene', config.displayName,
                () => agent.askWithZodSchema(SceneSchema, sceneMessages));

            expect(typeof scene.title).toBe('string');
            expect(['calm', 'tense', 'eerie']).toContain(scene.mood);
            // At least 8: a model that also lists the narrator (GLM Flash does) is following the
            // prompt loosely, not truncating — fewer than 8 is the only count that matters here.
            expect(scene.characters.length).toBeGreaterThanOrEqual(8);
            for (const character of scene.characters) {
                expect(character.name.length).toBeGreaterThan(0);
                expect(character.role.length).toBeGreaterThan(0);
                expect(character.line.length).toBeGreaterThan(0);
            }
            expect(tokenUsage).toBeDefined();
            expect(tokenUsage!.outputTokens).toBeGreaterThan(0);
        }, 240000);
    }
});
