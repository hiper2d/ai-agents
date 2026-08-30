# @hiper2d/ai-agents

Multi-provider AI agent layer for TypeScript apps: one `AbstractAgent` interface over 11 LLM
providers, schema-validated JSON asks (zod), reasoning/thinking extraction, a model catalog
with per-model tuning defaults, and token cost accounting (cache tiers, extended context,
peak-valley pricing).

Extracted from the [AI Werewolf](https://aiwerewolf.net) game so its model layer can be
shared across apps. Text agents today; TTS, STT and image-generation agents are planned as
subpath exports.

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
