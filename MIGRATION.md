# Adopting @hiper2d/ai-agents

Instructions for migrating a project that has its own LLM agent implementations onto this
library. Written to be handed to an AI coding assistant working in the consumer repo.

## What the library is

One `AbstractAgent` interface over 11 LLM providers (OpenAI, Anthropic, Google, DeepSeek,
Mistral, xAI/Grok, Moonshot/Kimi, Z.AI/GLM, Sakana, Qwen, MiniMax), plus:
- **Model catalog** — `SupportedAiModels` (API names, thinking dialect, reasoning-effort
  pins, output ceilings, speed/cost tags) and `LLM_CONSTANTS` (stable version-free ids:
  `LLM_CONSTANTS.CLAUDE_SONNET === 'claude-sonnet'`, currently mapping to Claude 5 Sonnet).
- **Cost accounting** — `MODEL_PRICING` + `calculateModelCost` (cache hits, extended-context
  tiers, DeepSeek weekday peak-valley pricing); every response returns a `TokenUsage` with
  `costUSD` already computed.
- **Schema-validated asks** — `askWithZodSchema(schema, messages)` conveys the schema in the
  provider's best dialect (native structured output, JSON mode, or prompt-based) and parses
  leniently (code fences, inline `<think>` leakage, trailing text).
- **Thinking/reasoning handling** — extraction into a separate return value, provider
  signature replay fields, per-provider effort clamping.

The catalog is **thinking-only**: every entry runs with reasoning enabled where the provider
supports it, with per-model pins (e.g. DeepSeek `reasoningEffort: 'low'`, Qwen
`thinkingBudgetTokens: 1024`) already tuned from production use.

## Install

```bash
npm i @hiper2d/ai-agents zod
```

`zod` (^3.25) is a peer dependency ON PURPOSE: the schema converter reads zod internals
(`_def`), and two zod copies across the package boundary break it. The consumer must have
exactly one zod. Provider SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`,
`@mistralai/mistralai`) come with the library as regular dependencies — do not add your own
copies unless you need them independently.

Ships compiled CJS + ESM + `.d.ts`; no transpilePackages / bundler config needed.

## Core usage

```ts
import {
    AgentFactory, LLM_CONSTANTS, API_KEY_CONSTANTS, type ApiKeyMap,
} from '@hiper2d/ai-agents';
import { z } from 'zod';

const apiKeys: ApiKeyMap = {
    [API_KEY_CONSTANTS.ANTHROPIC]: process.env.ANTHROPIC_API_KEY!,
    [API_KEY_CONSTANTS.DEEPSEEK]: process.env.DEEPSEEK_API_KEY!,
    // one entry per provider you use; keys of API_KEY_CONSTANTS name them all
};

const agent = AgentFactory.createAgent(
    'Mira',                       // agent name (logs, provider cache keys)
    'You are Mira, a cartographer.', // system instruction
    LLM_CONSTANTS.CLAUDE_SONNET,  // catalog id (a plain string; persist THIS in your DB)
    apiKeys,
);

// Structured ask — returns [parsed, thinking, usage?, signature?]
const [answer, thinking, usage] = await agent.askWithZodSchema(
    z.object({ reply: z.string() }),
    [{ role: 'user', content: 'Describe what you see.' }],
);
// answer.reply — validated against the schema
// thinking    — the model's reasoning where the provider surfaces it ('' otherwise)
// usage       — { inputTokens, outputTokens, totalTokens, costUSD, reasoningTokens?,
//                cachedInputTokens?, durationMs? }

// Plain text ask — same tuple with a string first element
const [text] = await agent.askText([{ role: 'user', content: 'Say hi.' }]);
```

Messages are `AIMessage[]`: `{ role: 'system'|'user'|'assistant'|'developer', content }` plus
optional thinking-replay fields (`anthropicThinkingSignature`, …) — store what a response's
4th tuple element gives you and put it back on the assistant message for multi-turn
reasoning continuity (matters for Claude, Gemini, Grok).

### Per-call tuning

Every agent exposes instance fields resolved from the catalog and overridable per call:

```ts
agent.maxOutputTokens = 16384;       // long-form call (default 8192)
agent.reasoningEffort = 'high';      // effort-dialect providers; clamped per provider
agent.thinkingBudgetTokens = 8192;   // budget-dialect providers (Qwen, Claude Haiku)
```

Note: on Qwen, `reasoning_effort` is a live-verified no-op — `thinkingBudgetTokens` is the
only real knob there. The library handles this; just set both fields and each provider uses
the one it understands.

### Logging

The library logs through an injectable sink. Route it to your logger once at startup:

```ts
import { setLlmLogger } from '@hiper2d/ai-agents';
setLlmLogger({ debug: myLog, info: myLog, warn: myWarn, error: myError });
```

Default is console. Per-agent verbosity is the constructor's `AgentLoggingConfig` (the
factory uses defaults; pass a silent config in tests — see the library's own suites).

### Errors

Typed errors from `@hiper2d/ai-agents`: `ModelError` base with `ModelOverloadError`,
`ModelRateLimitError`, `ModelUnavailableError`, `ModelAuthenticationError`,
`ModelQuotaExceededError`, `ModelRefusalError` (Anthropic safety refusal — NOT retryable
with the same prompt), plus `BotResponseError` (generic wrapped failure with a `recoverable`
flag). Catch `ModelError` subclasses first, then `BotResponseError`.

## The migration itself

1. **Inventory** the repo's bespoke agent layer: provider client wrappers, prompt→JSON
   plumbing, retry/parse helpers, price tables, model-id constants. That is the code this
   package replaces.
2. **Replace mechanics, keep policy.** Delete provider wrappers, JSON parsing/repair,
   thinking extraction, token/price math — call the library instead. KEEP anything that is
   the app's business: which models the app offers, tier/quota rules, retired-id → current-id
   maps, default model choices, domain prompts. Put those in one app-side module that layers
   on the library (see werewolf's `app/ai/ai-models.ts` for the reference pattern; its
   CLAUDE.md documents the split).
3. **Persist catalog ids** (`'claude-sonnet'`, `'deepseek-flash'`, …) in your data, never
   provider API names — ids survive model-version bumps. If the app already persisted other
   ids, write a small resolve map from old ids to catalog ids and apply it before
   `createAgent`.
4. **Don't fork the catalog for taste differences** — `createCatalog(overrides)` gives
   per-model shallow overrides (e.g. `createCatalog({ glm: { temperature: 0.9 } })`).
5. **Delete the old tests for deleted mechanics.** The library carries its own unit suites
   and live per-provider suites; keep only tests that exercise the app's prompts/policy.
6. **Model facts belong upstream.** A wrong price, a new model, a provider contract change —
   fix it in this repo's `src/catalog.ts` (+ agent), release, bump the dependency. Never
   patch model facts app-side.

## Verifying a migration

- Typecheck + the app's test suite.
- One live call per provider the app actually uses, through the app's own factory path.
- Check a real response's `usage.costUSD` against the provider console once.

## Releases (this repo)

Bump `version` in package.json, commit, `git tag vX.Y.Z && git push origin main vX.Y.Z`.
GitHub Actions publishes via npm Trusted Publishing. Run `npm run test:live` before tagging
when agents or SDKs changed.
