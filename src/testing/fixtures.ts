/**
 * Shared fixtures for the library's own test suites. Not part of the public API (tsup only
 * bundles what src/index.ts reaches). Everything here is deliberately domain-neutral: the
 * suites were born inside a werewolf game and used its prompts; the library must not.
 */
import { z } from 'zod';
import { API_KEY_CONSTANTS } from '../catalog';
import { CACHE_TIER_MARKER } from '../cache-tier';
import type { AgentLoggingConfig, AIMessage, ApiKeyMap } from '../types';

/** Logging config that keeps test output quiet. */
export const SILENT_LOGGING: AgentLoggingConfig = {
    enabled: false,
    logSystemPrompt: false,
    history: { enabled: false, maxCharactersPerMessage: 0 },
    logCommand: false,
    reply: { mode: 'body-only', maxReplyChars: 0, maxThinkingChars: 0, includeReasoning: false, includeUsage: false },
};

/** A placeholder key for every provider — enough to construct any agent without calling it. */
export const TEST_API_KEYS: ApiKeyMap = Object.fromEntries(
    Object.values(API_KEY_CONSTANTS).map(name => [name, 'test-key'])
) as ApiKeyMap;

/** Real keys from the environment (names match API_KEY_CONSTANTS), for live suites. */
export function liveApiKeys(): ApiKeyMap {
    const keys: ApiKeyMap = {};
    for (const name of Object.values(API_KEY_CONSTANTS)) {
        const value = process.env[name];
        if (value) keys[name] = value;
    }
    return keys;
}

/** `%placeholder%` substitution, the same shape the original prompts used. */
export function format(template: string, params: Record<string, string | number>): string {
    return template.replace(/%(\w+)%/g, (match, key) => (key in params ? String(params[key]) : match));
}

/**
 * A two-tier system prompt: a shared, placeholder-free tier above CACHE_TIER_MARKER (so the
 * prefix is byte-identical across characters and prompt caches hit) and a per-character
 * tier below it.
 */
export const ASSISTANT_SYSTEM_PROMPT = `You are a character in a collaborative text adventure. Stay in character, answer briefly,
and never reveal that you are an AI. When asked for JSON, reply with a single JSON object and nothing else.

Rules of the game:
- The party explores a ruined castle together.
- Each turn, one character speaks; the others react.
- Keep replies under three sentences unless a longer answer is explicitly requested.
${CACHE_TIER_MARKER}
Your name is %name%. Your background: %background%.
Speaking style: %style%.`;

export const CHARACTER_PARAMS = { name: 'Mira', background: 'a retired cartographer', style: 'dry and precise' };

export function assistantPrompt(overrides: Partial<typeof CHARACTER_PARAMS> = {}): string {
    return format(ASSISTANT_SYSTEM_PROMPT, { ...CHARACTER_PARAMS, ...overrides });
}

/** Minimal schemas the suites validate against. */
export const ReplySchema = z.object({ reply: z.string() });
export type Reply = z.infer<typeof ReplySchema>;

export const ChoiceSchema = z.object({
    choice: z.string().describe('The option you pick, verbatim from the list'),
    reasoning: z.string().describe('One sentence on why'),
});
export type Choice = z.infer<typeof ChoiceSchema>;

export const SceneSchema = z.object({
    title: z.string(),
    mood: z.enum(['calm', 'tense', 'eerie']),
    characters: z.array(z.object({ name: z.string(), role: z.string(), line: z.string() })).min(1),
});

/** A short alternating conversation to feed askText / askWithZodSchema. */
export function sampleHistory(): AIMessage[] {
    return [
        { role: 'user', content: 'Narrator: The party reaches a locked iron door. Torchlight flickers.' },
        { role: 'assistant', content: 'Mira: "Maps of this wing were always incomplete. Let me look at the hinges."' },
        { role: 'user', content: 'Narrator: Rust flakes away under her fingers. Something moves behind the door. What do you do?' },
    ];
}
