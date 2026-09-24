# @hiper2d/ai-agents

Multi-provider AI agent layer for TypeScript apps: one `AbstractAgent` interface over 12 LLM
providers, schema-validated JSON asks (zod), reasoning/thinking extraction, a model catalog
with per-model tuning defaults, and token cost accounting (cache tiers, extended context,
peak-valley pricing).

Extracted from the [AI Werewolf](https://aiwerewolf.net) game so its model layer can be
shared across apps. Text agents today; TTS, STT and image-generation agents are planned as
subpath exports.

Migrating a project that has its own agent implementations? Hand [`MIGRATION.md`](./MIGRATION.md)
to your AI coding assistant — it is written for that job.

## Install

```bash
npm i @hiper2d/ai-agents zod
```

`zod` is a peer dependency on purpose: the schema converter reads zod internals, and two
copies of zod across a package boundary would break it.

## Use

```ts
import { AgentFactory, LLM_CONSTANTS, API_KEY_CONSTANTS } from '@hiper2d/ai-agents';
import { z } from 'zod';

const agent = AgentFactory.createAgent(
    'Mira',                                     // agent name (used in logs and cache keys)
    'You are Mira, a retired cartographer.',   // system instruction
    LLM_CONSTANTS.CLAUDE_SONNET,             // catalog id
    { [API_KEY_CONSTANTS.ANTHROPIC]: process.env.ANTHROPIC_API_KEY! },
);

const [answer, thinking, usage] = await agent.askWithZodSchema(
    z.object({ reply: z.string() }),
    [{ role: 'user', content: 'What do you see?' }],
);
// answer.reply, thinking (provider reasoning, when surfaced), usage.costUSD
```

`askText(messages)` returns plain text the same way. Every agent honors per-instance
`maxOutputTokens`, `reasoningEffort` and `thinkingBudgetTokens` (catalog defaults,
overridable per call).

### Catalog and pricing

`SupportedAiModels` is the model catalog (API names, thinking dialect, reasoning-effort
pins, output ceilings, speed/cost tags); `MODEL_PRICING` the price table; `calculateModelCost`
the cost function. Consumers layer their own policy on top:

```ts
import { createCatalog } from '@hiper2d/ai-agents';
const catalog = createCatalog({ glm: { temperature: 0.9 } }); // shallow per-model overrides
```

### Voice agents

Speech and transcription behind the same factory pattern. Agents are pure — no auth or
billing — and every result reports its cost so the host decides whom to charge.

```ts
import { VoiceAgentFactory, API_KEY_CONSTANTS } from '@hiper2d/ai-agents';

const voice = VoiceAgentFactory.createAgentFromKeys('google', { [API_KEY_CONSTANTS.GOOGLE]: process.env.GOOGLE_API_KEY! });
const { audio, costUSD } = await voice.speak({ text: 'Night falls.', voice: 'Kore', voiceStyle: 'gravely' }); // WAV
const { text } = await voice.transcribe({ audio: recording, mimeType: 'audio/webm' });
```

`openai` runs gpt-4o-mini-tts + Whisper, `google` runs Gemini 3.8 Flash-Lite TTS + Gemini 3.5
Transcribe (`VOICE_MODEL_CONSTANTS`, prices in `VOICE_MODEL_PRICING`). The `voiceStyle`
direction works for both providers: OpenAI takes it as instructions, Gemini as the part's
`speechMetadata.style` (3.8 TTS reads the text verbatim, so no inline "Say X:" prefix).

### Images and portrait sheets (`@hiper2d/ai-agents/images`)

A separate entry for hosts that draw pictures. `generateImage` is one Gemini image call
that reports its cost; `drawPortraitSheet` draws a whole cast as one grid of bust
portraits and cuts it into one 3:4 card per character — one image call whether the cast
is three or sixteen, all in one consistent style. The divider lines the model draws are
read off the pixels (rows drift), and the kept sheet plus per-card framing let the host
re-cut any card later at a new crop. The library never imports sharp: pass your own
instance in, so text-only consumers pull in nothing native.

```ts
import { drawPortraitSheet, cutCard } from '@hiper2d/ai-agents/images';

const sharp = (await import('sharp')).default;
const { portraits, sheet, costUSD } = await drawPortraitSheet(googleKey, sharp, {
    purpose: 'a social deduction game',
    setting: { title: 'Harbor of Glass', description: 'A rain-soaked port city of lantern-lit canals.' },
    artStyle: 'ink and watercolor',
    cells: cast.map(c => ({ key: c.id, label: c.name, prompt: `(${c.gender}) "${c.name}" — ${c.look}` })),
});
// portraits[i].jpeg is a 600x800 card, portraits[i].framing says where it sits on sheet.jpeg
```

The pure geometry (`fitFraming`, `circleFocus`, `focusToBackground`, …) is safe in a
browser bundle for reframe editors and avatar renderers.

### Budget control

Per-subject spend caps (a user, a tenant, a job) over UTC day and month windows. Pure and
storage-agnostic: period keys, an O(1) rolling ledger that is overwritten when the period
rolls, a verdict function, and `BudgetExceededError` carrying the verdict (`resetsAt`,
`remainingUSD`) so the host can render "come back at …" instead of a provider failure.

```ts
import { BudgetController, InMemorySpendStore, BudgetExceededError } from '@hiper2d/ai-agents';

const budget = new BudgetController(new InMemorySpendStore(), {
  limits: [{ window: 'day', limitUSD: 5 }, { window: 'month', limitUSD: 20 }],
});
await budget.assertWithinBudget(userId);          // cheap pre-call guard, throws BudgetExceededError
const { costUSD } = await agent.ask(...);
await budget.record(userId, costUSD);              // re-checks inside the store's atomic update
```

Hosts that bill inside their own database transaction skip the controller and call the
pure pieces there: `ledgerSpend` → `evaluateBudget` → `applySpend`. Implement `SpendStore`
to back the controller with Redis, Postgres, Firestore, etc.

To guard every LLM call without touching call sites, install a process-wide pre-ask hook
once at startup. It runs before each `askText` / `askWithZodSchema` with the agent, so a
throwing hook refuses the call before anything reaches the provider:

```ts
import { setBeforeAskHook } from '@hiper2d/ai-agents';
setBeforeAskHook(async agent => { if (agent.userId) await budget.assertWithinBudget(agent.userId); });
```

### Logging

The library logs through an injectable sink — `setLlmLogger(fn)` — so a host app can route
agent request/response logs to its own logger. Default: console.

## Development

```bash
npm test          # unit suites (mocked, free)
npm run test:live # *.live.test.ts — real provider calls; needs keys in .env (see .env.example)
npm run build     # tsup → dist/ (cjs + esm + d.ts)
```

Live suites skip themselves per provider when the key is missing.

## Releasing

Bump `version` in package.json, commit, then tag and push:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

The `Publish` workflow verifies the tag matches the package version, runs typecheck/tests/build,
and publishes to npm with provenance via Trusted Publishing (OIDC — no token secret; configured
once on the npm package's settings page). A tag whose version is already on npm is a no-op.

## License

MIT
