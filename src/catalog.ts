/**
 * Model catalog and pricing.
 *
 * This is the library's single source of truth for how to talk to each supported model —
 * API name, key name, thinking dialect, per-model tuning defaults (temperature, reasoning
 * effort, thinking budgets, output ceilings) — and what each model costs. Tuning values are
 * operational defaults discovered against the live APIs; consumers can adjust them per model
 * via `createCatalog(overrides)`, but anything that would ever be fixed for *correctness*
 * (a model rejecting a parameter, an effort level eating the output budget) belongs here,
 * so every consumer inherits the fix with a version bump.
 *
 * App-level policy — tier limits, deprecated-id migration, markup — deliberately lives in
 * the consumer, keyed by the same stable model ids.
 */

export const API_KEY_CONSTANTS = {
    OPENAI: 'OPENAI_API_KEY',
    ANTHROPIC: 'ANTHROPIC_API_KEY',
    GOOGLE: 'GOOGLE_API_KEY',
    MISTRAL: 'MISTRAL_API_KEY',
    DEEPSEEK: 'DEEPSEEK_API_KEY',
    GROK: 'GROK_API_KEY',
    MOONSHOT: 'MOONSHOT_API_KEY',
    Z_AI: 'Z_AI_API_KEY',
    FUGU: 'FUGU_API_KEY',
    QWEN: 'QWEN_API_KEY',
    MINIMAX: 'MINIMAX_API_KEY',
    META: 'META_API_KEY'
} as const;

export const SupportedAiKeyNames: Record<string, string> = {
    [API_KEY_CONSTANTS.OPENAI]: 'OpenAI',
    [API_KEY_CONSTANTS.ANTHROPIC]: 'Anthropic',
    [API_KEY_CONSTANTS.GOOGLE]: 'Google',
    [API_KEY_CONSTANTS.MISTRAL]: 'Mistral',
    [API_KEY_CONSTANTS.DEEPSEEK]: 'DeepSeek',
    [API_KEY_CONSTANTS.GROK]: 'Grok',
    [API_KEY_CONSTANTS.MOONSHOT]: 'Moonshot',
    [API_KEY_CONSTANTS.Z_AI]: 'Z.AI',
    [API_KEY_CONSTANTS.FUGU]: 'Sakana Fugu',
    [API_KEY_CONSTANTS.QWEN]: 'Qwen',
    [API_KEY_CONSTANTS.MINIMAX]: 'MiniMax',
    [API_KEY_CONSTANTS.META]: 'Meta'
};

// Naming rule: a constant's NAME is its id in upper snake case (CLAUDE_SONNET === 'claude-sonnet').
// Ids are version-free on purpose — they are persisted by consumers, so a model bump changes only
// the entry (displayName / modelApiName), never the id or the constant. Enforced by catalog.test.ts.
export const LLM_CONSTANTS = {
    // Thinking-only catalog since 2026-08-05: models whose API offers a thinking toggle used to
    // ship as separate with/without picker entries. The non-thinking variants were retired and
    // the surviving thinking entries took over the plain ids ('claude-opus', 'glm', …).
    // Ids are stable slot names, independent of provider version, so repointing a slot to a
    // newer model doesn't orphan ids persisted by consumers.
    CLAUDE_FABLE: 'claude-fable',
    CLAUDE_OPUS: 'claude-opus',
    CLAUDE_SONNET: 'claude-sonnet',
    CLAUDE_HAIKU: 'claude-haiku',
    DEEPSEEK_FLASH: 'deepseek-flash',
    DEEPSEEK_PRO: 'deepseek-pro',
    // GPT-5.6 family. 'gpt' and 'gpt-mini' are stable picker ids carried over from the
    // GPT-5.5 / GPT-5.4-mini era so existing consumers keep working across the repoint.
    GPT_ASTRA: 'gpt-astra',
    GPT_SOL: 'gpt-sol',
    GPT: 'gpt',
    GPT_MINI: 'gpt-mini',
    // Gemini 4 Argon sits above Pro; version-free id so a later Argon repoint keeps persisted ids.
    GEMINI_ARGON: 'gemini-argon',
    GEMINI_PRO: 'gemini-pro',
    GEMINI_FLASH: 'gemini-flash',
    GEMINI_LITE: 'gemini-lite',
    MISTRAL_SMALL: 'mistral-small',
    GROK: 'grok',
    KIMI: 'kimi',
    // Kimi K3.1 Pro Highspeed: the same model served 2-3x faster at 2x the price (added
    // 2026-10-23). Version-free like `kimi`, so a K3.2 repoint keeps both ids.
    KIMI_HIGHSPEED: 'kimi-highspeed',
    GLM: 'glm',
    GLM_FLASH: 'glm-flash',
    FUGU_MAX: 'fugu-max',
    // Qwen (QwenCloud/DashScope). Stable picker ids without the version, matching the gpt/gemini
    // pattern, so future repoints don't orphan persisted ids.
    QWEN_MAX: 'qwen-max',
    QWEN_FLASH: 'qwen-flash',
    // MiniMax. Single M3 entry; stable id without the version for the same repoint reason.
    MINIMAX: 'minimax',
    // Meta Model API (api.meta.ai). Muse Spark; version-free id so a 1.3 → 1.4 repoint is entry-only.
    MUSE_SPARK: 'muse-spark',
    // Muse Wonder, Meta's larger model above Spark (added 2026-10-13); same version-free pattern.
    MUSE_WONDER: 'muse-wonder',
}

/**
 * Per-request output ceiling for ordinary requests. Reasoning tokens are billed inside this
 * budget on every provider, so the cap has to clear thinking AND the answer — set below what
 * a request really emits and the *answer* is what gets truncated, producing malformed JSON
 * rather than a cheaper request.
 *
 * NOTE this is a blast-radius cap, not a cost lever: providers bill tokens generated, never
 * the unused ceiling. Lowering it saves nothing on a well-behaved request — it only bounds a
 * runaway one. Reasoning effort and thinking budgets are the knobs that change spend.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Wall-clock limit on one ask, retries inside the provider SDK included. Past it the ask
 * throws ModelTimeoutError. Measured 2026-10-01 over 7k production calls (14 days): 0.5%
 * ran past 60s — mostly Grok turns and story generation. Callers that legitimately need
 * longer raise `requestTimeoutMs` on the instance, like maxOutputTokens.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// Speed tags graded from live measurements (one identical prompt per model;
// re-graded 2026-08-04, very-slow tier added 2026-08-05): very-fast < 3s, fast 3-6s,
// slow 15-25s, very-slow > 25s (the K3 / Qwen Max cluster), extremely-slow = minutes
// (Fugu Ultra exclusively). Models in the 6-13s middle carry NO speed tag on purpose — "medium"
// is the unlabeled default. Single-sample measurements: trust the bucket, not fine ordering.
export type ModelTag = 'very-fast' | 'fast' | 'slow' | 'very-slow' | 'extremely-slow' | 'cheap' | 'expensive';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * What a catalog entry produces. Only text agents exist today; TTS, STT and image
 * generation are planned as subpath exports, and their catalog entries will carry the
 * matching modality so consumers can filter (a text-model picker must not list a voice).
 * Omitted means 'text'.
 */
export type Modality = 'text' | 'tts' | 'stt' | 'image';

export interface ModelConfig {
    displayName: string;
    modelApiName: string;
    apiKeyName: string;
    modality?: Modality; // Default 'text'; see Modality.
    hasThinking: boolean;
    temperature?: number; // Override agent default temperature; omit to use the agent's built-in default
    // Reasoning-depth knobs. Providers speak two dialects, so there are two fields; a model uses
    // at most one of them, and omitting it means "provider default" (e.g. GPT-5 runs at OpenAI's
    // default medium effort, Grok at its fixed "high"; Fugu Ultra's default is xhigh, so it is pinned).
    // ReasoningEffort is the superset of provider vocabularies — each provider accepts only its
    // own slice (see reasoning-effort.ts for the per-provider types), and every effort-aware
    // agent clamps the value to the nearest level its API takes before sending. So a catalog
    // pin or a per-call override can use any level; prefer one the model natively supports
    // (Anthropic adaptive low|medium|high|xhigh|max, OpenAI minimal|low|medium|high|xhigh,
    // Gemini 3.x minimal|low|medium|high — 3.1 Pro and 3.7/3.8 Flash reject 'minimal' —, Fugu
    // high|xhigh|max, GLM-5.3 and DeepSeek V4 low|high|max).
    reasoningEffort?: ReasoningEffort; // Effort-based APIs (Anthropic adaptive thinking, Gemini 3.x)
    thinkingBudgetTokens?: number; // Budget-based APIs (Anthropic enabled thinking, Qwen thinking_budget)
    // Per-request output ceiling, overriding DEFAULT_MAX_OUTPUT_TOKENS. Only set it for models
    // that measurably need more room than a typical request takes (see the DeepSeek entries,
    // whose reasoning tokens share this budget). Every agent honors it via AbstractAgent.
    maxOutputTokens?: number;
    tags?: ModelTag[];
}

export const SupportedAiModels: Record<string, ModelConfig> = {
    // Claude Fable 5.1 (2026-09-02, was Fable 5) - frontier reasoning model. Thinking is always on (no non-thinking variant).
    [LLM_CONSTANTS.CLAUDE_FABLE]: {
        displayName: 'Claude Fable 5.1',
        modelApiName: 'claude-fable-5-1',
        apiKeyName: API_KEY_CONSTANTS.ANTHROPIC,
        hasThinking: true,
        reasoningEffort: 'high',
        tags: ['expensive'],
    },

    // Claude models — thinking-only entries (non-thinking variants retired 2026-08-05)
    // Opus moved 5 → 5.5 on 2026-09-22 (`claude-opus-5-5`, verified against GET /v1/models).
    // Cheaper than Opus 5 ($4/$20 vs $5/$25) and the same 1M context / 128K output. Thinking is
    // always on, as on Opus 5. Its API default effort is `medium`, but we keep the catalog-wide
    // `high` pin so bot answers don't get shallower than every other model in the lobby.
    [LLM_CONSTANTS.CLAUDE_OPUS]: {
        displayName: 'Claude 5.5 Opus',
        modelApiName: 'claude-opus-5-5',
        apiKeyName: API_KEY_CONSTANTS.ANTHROPIC,
        hasThinking: true,
        reasoningEffort: 'high',
        tags: ['expensive'],
    },
    // Sonnet moved 5 → 5.5 on 2026-09-28 (`claude-sonnet-5-5`, verified live with the platform key).
    // Same price, 1M context / 128K output. Adaptive thinking, API default effort `high` (effort
    // levels were recalibrated vs Sonnet 5 — same pin, not necessarily the same thinking depth).
    // It rejects `thinking: {type: "disabled"}`; ClaudeAgent sends `between_tools` instead. It
    // reads Sonnet 5 thinking blocks, so games moving onto it keep the bots' earlier reasoning.
    [LLM_CONSTANTS.CLAUDE_SONNET]: {
        displayName: 'Claude 5.5 Sonnet',
        modelApiName: 'claude-sonnet-5-5',
        apiKeyName: API_KEY_CONSTANTS.ANTHROPIC,
        hasThinking: true,
        reasoningEffort: 'high',
        tags: ['expensive'],
    },
    // Haiku moved 4.5 → 5.5 on 2026-10-08 (`claude-haiku-5-5`, verified live with the platform
    // key). 10x cheaper ($0.10/$0.50 up to 100K-token prompts), 1M context / 128K output.
    // Adaptive thinking now (the `enabled` + budget_tokens mode 4.5 used is rejected), API
    // default effort `medium`; we pin `high` like the other Claude entries. It reads Haiku 4.5
    // thinking blocks, so games moving onto it keep the bots' earlier reasoning. 'slow' tag
    // dropped: Anthropic lists it as the fastest model in the lineup.
    [LLM_CONSTANTS.CLAUDE_HAIKU]: {
        displayName: 'Claude 5.5 Haiku',
        modelApiName: 'claude-haiku-5-5',
        apiKeyName: API_KEY_CONSTANTS.ANTHROPIC,
        hasThinking: true,
        reasoningEffort: 'high',
        tags: ['cheap'],
    },

    // DeepSeek V4 models — thinking-only entries (non-thinking variants retired 2026-08-05).
    // reasoningEffort pinned to 'low' 2026-08-30: at the provider default ('high', no budget
    // knob exists) both models emitted ~8 reasoning tokens per answer token in prod
    // (requestStats 30d: flash p50 8.9s / p90 36s, pro p50 18.9s / p90 56s) and a 15-bot story
    // took 68-105s. Latency tracks reasoning length ~linearly, so effort is the only lever.
    // Flash moved to V4.1 2026-09-12: the API id is now the version-free alias `deepseek-flash`
    // (the retired `deepseek-v4-flash` still resolves to V4.1 server-side at the Flash price).
    [LLM_CONSTANTS.DEEPSEEK_FLASH]: {
        displayName: 'DeepSeek V4.1 Flash',
        modelApiName: 'deepseek-flash',
        apiKeyName: API_KEY_CONSTANTS.DEEPSEEK,
        hasThinking: true,
        reasoningEffort: 'low',
        // Reasoning tokens share the output budget, so leave room for both CoT and answer.
        maxOutputTokens: 65536,
        tags: ['cheap'],
    },
    [LLM_CONSTANTS.DEEPSEEK_PRO]: {
        displayName: 'DeepSeek V4 Pro',
        modelApiName: 'deepseek-v4-pro',
        apiKeyName: API_KEY_CONSTANTS.DEEPSEEK,
        hasThinking: true,
        reasoningEffort: 'low',
        // Reasoning tokens share the output budget, so leave room for both CoT and answer.
        maxOutputTokens: 65536,
        // slow: werewolf prod 2026-10-21, 785 calls over 30 days, p50 10s, p90 31s, max 156s;
        // 7 of 79 bot turns past the 60s timeout in a 16-player game at days 8-9.
        tags: ['slow', 'cheap'],
    },

    // Models with always-on reasoning
    // GPT-6 Astra (2026-09-03): OpenAI's frontier tier above Sol. No `none` reasoning effort;
    // temperature/top_p are rejected — Gpt5Agent sends neither, so the same agent serves it.
    // The catalog temperature is only carried for the agent constructor signature.
    // All four OpenAI entries carry reasoningEffort: 'medium' as of 2026-09-22. That is
    // OpenAI's own current default, established by MEASUREMENT rather than docs: each model was
    // called with no reasoning param and the effort it echoes back read off the response, since
    // OpenAI documents the default for Sol, Luna and the 5.6 family but never states Astra's.
    // Pinning it changes no behaviour today; it stops the default moving under us silently.
    [LLM_CONSTANTS.GPT_ASTRA]: {
        displayName: 'GPT-6 Astra',
        modelApiName: 'gpt-6-astra',
        apiKeyName: API_KEY_CONSTANTS.OPENAI,
        reasoningEffort: 'medium',
        hasThinking: true,
        temperature: 1,
        tags: ['expensive'],
    },
    // Sol and Luna moved to GPT-6 on 2026-09-22 (both ids verified against GET /v1/models).
    // GPT-6 ships Astra, Sol and Luna only — there is NO gpt-6-terra, so the Terra slot stays on
    // gpt-5.6-terra, which OpenAI still serves. Both moves are big price cuts: Sol halved
    // ($4/$20 → $2/$10) and Luna halved ($0.20/$1.20 → $0.10/$0.50). Note GPT-6 Sol now
    // undercuts GPT-5.6 Terra ($2/$12) on output at the same input rate, which makes the Terra
    // slot largely redundant — retiring it is a product call, not a catalog one.
    // Sol → GPT-6.1 Sol on 2026-09-29 (id verified against GET /v1/models; gpt-6-sol is still
    // served). Same price as GPT-6 Sol; its no-param default effort still measures `medium`.
    // Terra → GPT-6.1 Terra on 2026-10-26 (id verified against GET /v1/models; gpt-5.6-terra is
    // still served). Half the price of 5.6 Terra ($2/$12 → $1/$5) and back in its place below
    // Sol. Its no-param default effort measures `medium`, like its siblings.
    [LLM_CONSTANTS.GPT_SOL]: {
        displayName: 'GPT-6.1 Sol',
        modelApiName: 'gpt-6.1-sol',
        apiKeyName: API_KEY_CONSTANTS.OPENAI,
        reasoningEffort: 'medium',
        hasThinking: true,
        temperature: 1,
        tags: ['expensive'],
    },
    [LLM_CONSTANTS.GPT]: {
        displayName: 'GPT-6.1 Terra',
        modelApiName: 'gpt-6.1-terra',
        apiKeyName: API_KEY_CONSTANTS.OPENAI,
        reasoningEffort: 'medium',
        hasThinking: true,
        temperature: 1,
        tags: ['fast', 'expensive'],
    },
    [LLM_CONSTANTS.GPT_MINI]: {
        displayName: 'GPT-6 Luna',
        modelApiName: 'gpt-6-luna',
        apiKeyName: API_KEY_CONSTANTS.OPENAI,
        reasoningEffort: 'medium',
        hasThinking: true,
        temperature: 1,
        tags: ['fast', 'cheap'],
    },
    // Gemini 3.x reasons via the effort dialect (thinkingLevel). The level is a CEILING on an
    // always-dynamic process — the model still scales actual thinking depth per request within
    // it; "high" is the fully open dynamic range. Levels below are each model's documented
    // default (Pro accepts low|medium|high only — no minimal). This replaced the deprecated
    // 2.5-era thinkingBudget: 1024 (2026-08-06), which HAD been binding — so Flash Lite now
    // thinks noticeably less under its "minimal" default (0.8s/49-token votes vs 4.5s/650
    // budgeted); bump it to 'low' if its output quality visibly drops.
    // Gemini 4 Argon (added 2026-10-13, id verified against GET /v1beta/models): Google's
    // flagship reasoning model, 1M in / 32K out. Same thinkingLevel dialect as 3.x — accepts
    // low|medium|high, rejects 'minimal' (probed). Pinned 'high' like Pro: on a 1.7K-token game
    // prompt 'medium' thought 0 tokens (3.2s) while 'high' thought 622 (8.1s); the level is a
    // ceiling, so 'high' leaves the dynamic range open. No `temperature`: Gemini 4 accepts it
    // but Google deprecated sampling params (see the Pro note). Story-pipeline speed as Game
    // Master not measured yet — run the host's live story suite before trusting it there.
    // Pinned medium 2026-10-14 (was high since it shipped on 2026-10-13). Two days of
    // production turns at high measured p50 21s / p90 40s with three 60s timeouts, and the
    // werewolf day-2 vote fixture took 16-34s (380-415 output tokens). At medium the same
    // prompt took 4-11s (75-110 output tokens) with the same vote target and a reason just
    // as specific — the same trade Grok 4.7 made on 2026-10-06.
    [LLM_CONSTANTS.GEMINI_ARGON]: {
        displayName: 'Gemini 4 Argon',
        modelApiName: 'gemini-4-argon',
        apiKeyName: API_KEY_CONSTANTS.GOOGLE,
        hasThinking: true,
        reasoningEffort: 'medium',
        // slow: werewolf prod 2026-10-21, 193 calls over 30 days, p50 12s, p90 34s, max 207s;
        // 3 of 50 night actions past the 60s timeout even at medium effort.
        tags: ['slow', 'expensive'],
    },
    [LLM_CONSTANTS.GEMINI_PRO]: {
        displayName: 'Gemini 3.1 Pro Preview',
        modelApiName: 'gemini-3.1-pro-preview',
        apiKeyName: API_KEY_CONSTANTS.GOOGLE,
        hasThinking: true,
        reasoningEffort: 'high',
        // Pre-3.6: still honours sampling params, so it keeps the 0.2 GoogleAgent always sent
        // before 2026-10-07. 3.6+ ignore them and future Gemini models reject them — leave
        // `temperature` unset on every newer Gemini entry (GoogleAgent then sends none).
        temperature: 0.2,
        tags: ['expensive'],
    },
    [LLM_CONSTANTS.GEMINI_FLASH]: {
        // Repointed 3.6 → 3.7 (2026-08-13) → 3.8 (2026-09-02); stable picker id, same pattern as gpt.
        // 3.7 rejected thinkingLevel 'minimal' (low|medium|high only), unlike 3.5/3.6 — 3.8 untested
        // on 'minimal', so keep the pin at 'medium' or above.
        displayName: 'Gemini 3.8 Flash',
        modelApiName: 'gemini-3.8-flash',
        apiKeyName: API_KEY_CONSTANTS.GOOGLE,
        hasThinking: true,
        reasoningEffort: 'medium',
        tags: ['fast'],
    },
    [LLM_CONSTANTS.GEMINI_LITE]: {
        displayName: 'Gemini 3.5 Flash Lite',
        modelApiName: 'gemini-3.5-flash-lite',
        apiKeyName: API_KEY_CONSTANTS.GOOGLE,
        hasThinking: true,
        reasoningEffort: 'minimal',
        // Pre-3.6, same as Pro: keeps the 0.2 it always had.
        temperature: 0.2,
        tags: ['fast', 'cheap'],
    },
    // Always-on reasoning — no non-thinking sibling. Bumped 4.6 → 4.7 on 2026-09-22 (id verified
    // against GET /v1/models). Same price, same 200K extended-context boundary; the context
    // window is 500K. 4.7 accepts `reasoning: {effort}` (low | medium | high | xhigh, default
    // high) where 4.6 had no knob at all; GrokAgent sends the pin below.
    //
    // Pinned medium 2026-10-06. At high, production day summaries ran ~2 min and the werewolf
    // day-2 fixture measured votes 27-55s and summaries 44-55s (1.5-3k output tokens) — too
    // close to the 60s per-call timeout. At medium the same prompts took votes 5-8s and
    // summaries 23-25s (3-5x fewer output tokens) with the same vote target and summaries just
    // as specific.
    [LLM_CONSTANTS.GROK]: {
        displayName: 'Grok 4.7',
        modelApiName: 'grok-4.7',
        apiKeyName: API_KEY_CONSTANTS.GROK,
        hasThinking: true,
        reasoningEffort: 'medium',
        temperature: 0.7,
        // very-slow: werewolf prod 2026-10-21, 29 calls over 30 days, p50 48s, p90 192s, max 244s
        // at medium effort; the 15-character story pipeline took 213s on 2026-10-07.
        tags: ['very-slow'],
    },

    // Mistral models. One hybrid entry: reasoning is off by default on the API and switched on
    // per request with `reasoning_effort` (see mistral-agent.ts); the trace comes back as a
    // `thinking` content chunk and works with json_schema structured output (verified live
    // 2026-09-18). Pinned to 'high' — the only level Mistral's docs describe ("full thinking
    // chunk before the final answer"); Small is cheap enough that the extra tokens don't
    // matter. Live 2026-09-18 (one short schema ask): 1.7s with a ~600-char trace.
    //
    // Mistral Medium 3.5 (`mistral-medium-3-5`, $1.5/$7.5, $0.15 cached) was removed in 0.21.0
    // (2026-10-10): too slow and too expensive at the only reasoning level it takes (high|none).
    // Production 2026-10-03..10: p50 15.9s, p90 35.1s, $0.036 a request (2x Gemini 3.1 Pro,
    // 19x Small; reasoning spiked to 15-24k tokens), ~6% of calls failed (60s timeouts, empty
    // replies, empty JSON), and a 15-player story pipeline took 277s. Wait for Medium 4.
    //
    // Mistral Large 3 and Magistral Medium 1.2 were dropped 2026-09-18. Large 3 was retired by
    // Mistral on 2026-08-31 (the `-latest` alias still answered, but its capabilities say
    // reasoning: false and `reasoning_effort` is a 400 on it). Magistral was retired 2026-07-31
    // and `magistral-medium-latest` is now literally an alias of Medium 3.5 — the model list
    // returns `mistral-medium-3-5`, `mistral-medium-3`, `mistral-medium-latest` and
    // `magistral-medium-latest` as one entry — so Magistral seats had silently become Medium
    // seats already. Consumers map both retired ids onto Small (Medium itself is gone since 0.21.0).
    //
    // Mistral Large 4 (`mistral-large-4`, $0.68/$2.09, $0.07 cached) was added in 0.19.0 and
    // removed in 0.19.1 (2026-10-06/07): too slow to play. Like Small/Medium it accepts only
    // reasoning_effort high|none, and unlike them it reasons when the field is omitted. At high
    // a realistic day-2 vote took 25-154s (half past the 60s timeout) and its parallel story
    // batches finished ~100s apart (Mistral served them one at a time: ~6 min per story). Off,
    // it answers in ~1s with no trace. Re-test before re-adding.
    [LLM_CONSTANTS.MISTRAL_SMALL]: {
        displayName: 'Mistral 4 Small',
        // Resolves to mistral-small-2603 (Small 4), which also carries the magistral-small alias.
        modelApiName: 'mistral-small-latest',
        apiKeyName: API_KEY_CONSTANTS.MISTRAL,
        hasThinking: true,
        reasoningEffort: 'high',
        tags: ['very-fast', 'cheap'],
    },

    // Kimi models. Always-reasoning entries: K3-series models reason by default and the only way
    // to stop it is the undocumented K2-era `thinking: disabled` toggle, which we no longer rely on.
    // ~85-90% of output tokens are reasoning tokens billed at the output rate, so real
    // per-request cost runs well above the sticker output price.
    //
    // `kimi` repointed 2026-10-23 from kimi-k3 ($3/$15, 17-29s per turn, 146s for the
    // 15-character story pipeline) to Kimi K3.1 Pro ($2/$10, 1M context, same low|high|max
    // effort levels, default max). Live at high effort 2026-10-23: 3-sentence schema ask
    // 4.2-4.5s, 8-character scene (476-845 output tokens) 9.7-14.9s = 49-57 tok/s — the same
    // output speed as K3, so a full bot turn still lands in the 15-25s `slow` band.
    // Consumer policy (werewolf): 1 bot per free game (opt-in) until 100 turns are measured.
    [LLM_CONSTANTS.KIMI]: {
        displayName: 'Kimi K3.1 Pro',
        modelApiName: 'kimi-k3.1-pro',
        apiKeyName: API_KEY_CONSTANTS.MOONSHOT,
        hasThinking: true,
        // Temperature is omitted from the request: K3 rejected any value other than 1.
        // Pinned 'high' 2026-09-22, down from Moonshot's 'max' default: K3 had no levels at
        // launch and the agent hardcoded max, so this is the first time the knob exists.
        reasoningEffort: 'high',
        tags: ['slow', 'expensive'],
    },
    // Same model, Moonshot's high-speed serving tier ("roughly two to three times faster",
    // platform.kimi.ai K3.1 Pro quickstart, read 2026-10-23) at 2x the price ($4/$20 — Opus 5.5
    // money). Live the same day: schema ask 1.9-2.4s, 8-character scene (789-982 output tokens)
    // 7.9-8.4s = 100-117 tok/s, twice Pro. No speed tag: that is the unlabeled 6-13s middle.
    // Consumer policy (werewolf): paid tier only, deliberately — the estimate is 5.2¢ a turn.
    [LLM_CONSTANTS.KIMI_HIGHSPEED]: {
        displayName: 'Kimi K3.1 Pro Highspeed',
        modelApiName: 'kimi-k3.1-pro-highspeed',
        apiKeyName: API_KEY_CONSTANTS.MOONSHOT,
        hasThinking: true,
        reasoningEffort: 'high',
        tags: ['expensive'],
    },

    // Z.AI models — thinking-only entry (non-thinking variant retired 2026-08-05)
    // reasoningEffort MUST be set: GLM-5.3 forces reasoning on and defaults the effort to 'max',
    // and its reasoning tokens count against max_tokens. At 'max' a long-context request can
    // burn the whole 8192 budget on reasoning and return finish_reason 'length' with content ""
    // (prod empty-response incidents + live repro, 2026-08-20). 'high' answered the same test
    // prompt with ~10x fewer reasoning tokens.
    [LLM_CONSTANTS.GLM]: {
        displayName: 'GLM-5.3',
        modelApiName: 'glm-5.3',
        apiKeyName: API_KEY_CONSTANTS.Z_AI,
        hasThinking: true,
        temperature: 0.7,
        reasoningEffort: 'high',
        // Headroom for the shared reasoning+answer budget (like the DeepSeek entries), sized
        // at 2x default rather than DeepSeek's 65536 to bound worst-case latency on a slow model.
        maxOutputTokens: 16384,
        tags: ['slow'],
    },
    // GLM-5.3-Flash (added 2026-08-30): the cheap sibling. Same API contract as GLM-5.3 —
    // thinking cannot be disabled and reasoning_effort takes low|high|max only
    // (docs.z.ai/guides/llm/glm-5.3-flash, /guides/capabilities/thinking), so it gets the same
    // 'high' pin and the same reasoning+answer headroom.
    [LLM_CONSTANTS.GLM_FLASH]: {
        displayName: 'GLM-5.3 Flash',
        modelApiName: 'glm-5.3-flash',
        apiKeyName: API_KEY_CONSTANTS.Z_AI,
        hasThinking: true,
        temperature: 0.7,
        reasoningEffort: 'high',
        maxOutputTokens: 16384,
        // Live 2026-08-30 (one sample each): day-2 vote 11.8s, 15-character story 56.2s.
        tags: ['cheap'],
    },

    // Sakana Fugu models — OpenAI-compatible. They reason internally, but Chat Completions
    // (what FuguAgent uses) never returns the text: reasoning_tokens are reported and billed,
    // there is no reasoning_content. So hasThinking is false. Single entry per model.
    // The Messages and Responses APIs DO return reasoning (thinking blocks with an empty
    // signature / reasoning items, some with encrypted_content), but probed 2026-09-24 on
    // fugu-max it isn't worth switching for, since we keep reasoning only to replay it: the
    // returned text is often a vague status summary or empty rather than the actual
    // reasoning, and replayed reasoning reaches the model distorted (a planted "4817" came
    // back as "4829" on both APIs, presumably rewritten by the orchestrator).
    //
    // Base `fugu` was RETIRED 2026-08-04. It was carried as a cheap everyday option at an
    // assumed $1/$3, but reconciling token logs against the Sakana balance showed it actually
    // bills at fugu-ultra's rates: 592K prompt + 54K completion tokens over Aug 1-3 cost $4.80
    // real against $0.85 tracked, a 5.7x undercharge. It is a router with no published price,
    // so the rate is not even guaranteed stable, and its cache hit rate was 9.3% — effectively
    // zero, since every hit came from a duplicate call seconds apart rather than turn-to-turn
    // prefix reuse.
    //
    // reasoningEffort was PINNED on both entries because the server default differs per model:
    // fugu-ultra defaults to `xhigh` (console.sakana.ai/models), fugu-max to `high`. Until
    // 2026-09-20 the agent sent no effort at all, so every Ultra turn ran at xhigh. Measured that
    // day on a 2k-token three-day game prompt (two samples each, chat completions, json mode):
    //   ultra xhigh  148s / 265s   $0.34 / $0.50 a turn (orchestration tokens included)
    //   ultra high    65s /  78s   $0.16 / $0.17
    //   max   high     6s /  10s   $0.006 / $0.008
    //   max   xhigh   41s /  47s   $0.02
    // `max_tokens` is not a latency lever for Ultra: Sakana applies it to the final response only,
    // the orchestrator "still uses maximum token limit". Effort is the only knob.
    //
    // Fugu Ultra (`fugu-ultra`, $5/$30, $0.50 cached; ×~2 above 272K) was REMOVED in 0.19.1
    // (2026-10-07): too slow and too expensive for what it played. At `high` a day-2 vote took
    // 39s and a turn 65-78s (past the 60s request timeout), and as Game Master its four parallel
    // story batches ran past 240s each. It also billed "orchestration" tokens (its internal expert
    // calls) on top of the visible counts; FuguAgent still folds those in, in case Max ever
    // reports them. Consumers map the id to Max.
    // Fugu Max (2026-09-20, fugu-max → fugu-max-v1.0): Sakana's "largest pool of models on the
    // cost–performance Pareto frontier" — 5x less than Ultra's output rate and a fraction of its
    // latency; the only Fugu since 0.19.1. Live 2026-10-06: day-2 vote 11s, 15-character story
    // pipeline 100s. It reasons (reasoning_tokens 80-500 a turn) but, like
    // Ultra, never returns reasoning_content, hence hasThinking: false. No orchestration
    // tokens observed on any call.
    [LLM_CONSTANTS.FUGU_MAX]: {
        displayName: 'Sakana Fugu Max',
        modelApiName: 'fugu-max',
        apiKeyName: API_KEY_CONSTANTS.FUGU,
        hasThinking: false,
        reasoningEffort: 'high',
    },

    // Qwen models (QwenCloud, OpenAI-compatible endpoint). Added 2026-08-05 straight into the
    // thinking-only catalog: their API has an `enable_thinking` toggle, we always send true, and
    // thinking arrives in `reasoning_content` (verified live against all three, non-streaming).
    // Speed tags from the 2026-08-05 live measurements (two samples each): plus 17.4s/14.5s,
    // flash 14.3s/16.4s (both slow); max 30.6s/100.5s — its latency tracks how long it decides
    // to think (4.2K reasoning tokens on the slow run), hence the budget cap below.
    [LLM_CONSTANTS.QWEN_MAX]: {
        displayName: 'Qwen3.8 Max',
        modelApiName: 'qwen3.8-max',
        apiKeyName: API_KEY_CONSTANTS.QWEN,
        hasThinking: true,
        temperature: 0.7,
        // Caps `thinking_budget` to bound the 30–100s latency variance. The same knob works on
        // the 3.7 models (verified live) — add it to their entries if they ever need taming.
        thinkingBudgetTokens: 1024,
        // Capped it measures 25-26s → the >25s tier.
        tags: ['very-slow'],
    },
    // qwen3.8-flash replaced qwen3.7-flash on 2026-08-30 (same 1M context, 128k max output);
    // qwen3.7-plus was retired the same day — persisted 'qwen-plus' ids resolve to this entry
    // in consumers' deprecated-id maps. Live 2026-08-30 (one sample each): day-2 vote 13.8s,
    // 15-character story 26.4s — same bucket as 3.7-flash, so the tags carry over.
    [LLM_CONSTANTS.QWEN_FLASH]: {
        displayName: 'Qwen3.8 Flash',
        modelApiName: 'qwen3.8-flash',
        apiKeyName: API_KEY_CONSTANTS.QWEN,
        hasThinking: true,
        temperature: 0.7,
        // Uncapped it swung to 3K reasoning tokens (21s); same cap as its siblings.
        thinkingBudgetTokens: 1024,
        tags: ['slow', 'cheap'],
    },

    // MiniMax M3.1 Flash (OpenAI-compatible endpoint, 1M context). `minimax` repointed 2026-10-27
    // from MiniMax-M3 ($0.30/$1.20 after the permanent 50% off, 25s single-sample turn, 60s
    // timeouts in prod on 2026-10-25 and 10-27) to MiniMax-M3.1-Flash: half the price
    // ($0.15/$0.60), and the first MiniMax model with an effort dial — low|medium|high|xhigh|max,
    // provider default max, so it is pinned. Thinking is always on (`thinking: disabled` → 400),
    // thinking arrives in `reasoning_content` because the agent sends `reasoning_split: true`
    // (M3.1 rejects false). Temperature and top_p are documented as ignored ("not supported
    // yet", always 1 / 0.95), so the entry sets none and the agent sends none.
    // Live 2026-10-27 at medium: the all-providers sweep ran the schema ask in 3.1s, prose in
    // 1.7s and the 8-character scene (363 output tokens) in 2.4s — ~150 tok/s, the fastest
    // provider in the sweep that day (Kimi Highspeed's scene takes 8s); a 3.2k-token game
    // prompt with a two-sentence JSON reply took 1.9-2.1s at every effort level vs 3.5s for M3.
    // Tagged `fast` rather than `very-fast`: the sweep straddles the 3s line and production
    // turns carry 10k+ tokens of context. Launched 2026-09-27 as Token-Plan-only (the
    // 2026-10-02 probe got `unknown model` on the pay-as-you-go key); on the key since at
    // least 2026-10-27.
    [LLM_CONSTANTS.MINIMAX]: {
        displayName: 'MiniMax M3.1 Flash',
        modelApiName: 'MiniMax-M3.1-Flash',
        apiKeyName: API_KEY_CONSTANTS.MINIMAX,
        hasThinking: true,
        reasoningEffort: 'medium',
        tags: ['fast', 'cheap'],
    },

    // Meta Muse Spark 1.3 (added 2026-09-12) on Meta's own Model API — Standard tier, i.e.
    // the private model id (the `-contributor` id is a quarter of the price but Meta trains
    // on the prompts). Always-on reasoning with an effort dial (minimal … max, "none" is
    // rejected); the chain of thought is never returned, only an optional summary, plus
    // encrypted reasoning items replayed across turns like Grok. 'medium' is pinned as the
    // game default: turns are short and every reasoning token bills as output.
    // Temperature: Meta documents the model as tuned to its 1.0 default.
    // Speed: measured 2026-09-12 at medium effort — 9.6s on a full-context day-2 vote, 4-8s on
    // short turns (reasoning ≈ 90% of output tokens). That is the untagged middle band by the
    // grading above; tagged 'slow' anyway by decision so players expect a wait. Price-wise it
    // is neither cheap nor expensive.
    [LLM_CONSTANTS.MUSE_SPARK]: {
        displayName: 'Muse Spark 1.3',
        modelApiName: 'muse-spark-1.3',
        apiKeyName: API_KEY_CONSTANTS.META,
        hasThinking: true,
        temperature: 1,
        reasoningEffort: 'medium',
        tags: ['slow'],
    },
    // Muse Wonder 1.0 (added 2026-10-13, id verified against GET /v1/models): Meta's model above
    // Spark, Standard mode only (no Contributor tier). Same MetaAgent and effort vocabulary as
    // Spark; probed low/medium/high on a short game prompt: 347/455/565 reasoning tokens in
    // 5.9/7.3/8.5s, so the pin stays 'medium' like Spark. Game-length turns and the story
    // pipeline are unmeasured — not tagged 'slow' yet; the host decides on Game Master use.
    [LLM_CONSTANTS.MUSE_WONDER]: {
        displayName: 'Muse Wonder 1.0',
        modelApiName: 'muse-wonder-1.0',
        apiKeyName: API_KEY_CONSTANTS.META,
        hasThinking: true,
        temperature: 1,
        reasoningEffort: 'medium',
        tags: ['expensive'],
    },
};

export type LLMModel = keyof typeof SupportedAiModels;

/**
 * Builds a catalog from the library defaults with per-model partial overrides merged on top.
 * The merge is per-model and shallow: `{ glm: { temperature: 0.9 } }` changes only that field
 * and keeps the rest of the default entry. Ids absent from the defaults are added verbatim
 * (they must then be complete ModelConfig entries).
 */
export function createCatalog(overrides: Record<string, Partial<ModelConfig>> = {}): Record<string, ModelConfig> {
    const catalog: Record<string, ModelConfig> = {};
    for (const [id, config] of Object.entries(SupportedAiModels)) {
        catalog[id] = { ...config, ...(overrides[id] ?? {}) };
    }
    for (const [id, config] of Object.entries(overrides)) {
        if (!catalog[id]) {
            catalog[id] = config as ModelConfig;
        }
    }
    return catalog;
}

export function getModelTags(modelId: string): ModelTag[] {
    return SupportedAiModels[modelId]?.tags ?? [];
}

export function modelHasTag(modelId: string, tag: ModelTag): boolean {
    return getModelTags(modelId).includes(tag);
}

/** Speed is an ordered scale — "fast" filters must also admit very-fast models. */
export function modelIsFast(modelId: string): boolean {
    return modelHasTag(modelId, 'fast') || modelHasTag(modelId, 'very-fast');
}

export function getModelDisplayName(modelId: string): string {
    return SupportedAiModels[modelId]?.displayName ?? modelId;
}

/** Human-readable provider name ("Anthropic", "Grok", …) for a model id, if known. */
export function getModelProviderName(modelId: string): string | undefined {
    const apiKeyName = SupportedAiModels[modelId]?.apiKeyName;
    return apiKeyName ? SupportedAiKeyNames[apiKeyName] : undefined;
}

/**
 * Looks up a model's config by API name. Since the catalog went thinking-only (2026-08-05) each
 * modelApiName has a single entry, so hasThinking no longer disambiguates anything; it is kept
 * for call-site compatibility and as a filter should variants ever return.
 */
export function getModelConfigByApiName(modelApiName: string, hasThinking?: boolean): ModelConfig | undefined {
    const candidates = Object.values(SupportedAiModels).filter(config => config.modelApiName === modelApiName);
    if (hasThinking !== undefined) {
        const exact = candidates.find(config => config.hasThinking === hasThinking);
        if (exact) {
            return exact;
        }
    }
    return candidates[0];
}

/**
 * Model pricing configuration
 * All prices are in USD per 1,000,000 tokens
 */
/**
 * What a price is quoted per. Text models bill per million tokens; the planned TTS entries
 * bill per million characters, STT per minute of audio, image models per image (or per
 * output token, in which case they stay 'tokens'). Omitted means 'tokens'.
 */
export type PricingUnit = 'tokens' | 'characters' | 'minutes' | 'images';

export interface ModelPricing {
    unit?: PricingUnit;      // Default 'tokens'; see PricingUnit. Per-million for tokens/characters.
    inputPrice: number;      // Price per million input tokens
    outputPrice: number;     // Price per million output tokens
    cacheHitPrice?: number;  // Optional: Price per million cached tokens (if applicable)
    extendedContextInputPrice?: number; // Optional: Price per million input tokens when context exceeds threshold
    extendedContextOutputPrice?: number; // Optional: Price per million output tokens when context exceeds threshold
    extendedContextCacheHitPrice?: number; // Optional: Price per million cached tokens for extended contexts
    extendedContextThresholdTokens?: number; // Optional: Threshold at which extended pricing applies
    peakPricing?: PeakPricing; // Optional: time-of-day surcharge (e.g. DeepSeek peak-valley pricing)
}

/**
 * Time-of-day surcharge applied to all billing items (input, output, cache) when the
 * request falls inside one of the UTC windows.
 */
export interface PeakPricing {
    multiplier: number; // e.g. 2 → peak-hour prices are double the regular price
    windowsUtc: Array<[number, number]>; // [startHour, endHour) pairs in UTC, e.g. [[1, 4], [6, 10]]
    /** When set, the windows apply Monday–Friday only: a request that falls on a Saturday or
     *  Sunday in the provider's local timezone (given as a UTC offset in hours) bills at the
     *  base rate all day. */
    weekendOffPeak?: { utcOffsetHours: number };
}

/** True if the timestamp's UTC time-of-day falls inside any [startHour, endHour) window. */
export function isInPeakWindow(timestampMs: number, windowsUtc: Array<[number, number]>): boolean {
    const d = new Date(timestampMs);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    return windowsUtc.some(([start, end]) => hour >= start && hour < end);
}

/** True if the timestamp falls on a Saturday or Sunday in the timezone at the given UTC offset. */
export function isWeekendAt(timestampMs: number, utcOffsetHours: number): boolean {
    const day = new Date(timestampMs + utcOffsetHours * 3_600_000).getUTCDay();
    return day === 0 || day === 6;
}

/** True if a request at this timestamp bills at the peak multiplier under the schedule. */
export function isPeakBilling(timestampMs: number, peak: PeakPricing): boolean {
    if (peak.weekendOffPeak && isWeekendAt(timestampMs, peak.weekendOffPeak.utcOffsetHours)) {
        return false;
    }
    return isInPeakWindow(timestampMs, peak.windowsUtc);
}

/** DeepSeek's peak-valley schedule: 2× during Beijing 09:00–12:00 and 14:00–18:00
 *  (UTC 1–4, 6–10), Monday–Friday Beijing time only. */
export const DEEPSEEK_PEAK_SCHEDULE: PeakPricing = {
    multiplier: 2,
    windowsUtc: [[1, 4], [6, 10]],
    weekendOffPeak: { utcOffsetHours: 8 },
};

/**
 * Centralized pricing configuration for all AI models
 * All prices are per million (1,000,000) tokens
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
    // OpenAI GPT-6 Astra (developers.openai.com/api/docs/pricing, 2026-09-03): $10/$50 cache-hit $1
    // short context, $20/$75 cache-hit $2 long context. OpenAI's pricing table doesn't restate
    // the boundary; we assume the same 272k threshold as the GPT-5.6 siblings. Cache writes
    // ($12.50/$25) are not modelled — caching is automatic and we only see hits.
    [SupportedAiModels[LLM_CONSTANTS.GPT_ASTRA].modelApiName]: {
        inputPrice: 10.000,
        outputPrice: 50.000,
        cacheHitPrice: 1.000,
        extendedContextInputPrice: 20.000,
        extendedContextOutputPrice: 75.000,
        extendedContextCacheHitPrice: 2.000,
        extendedContextThresholdTokens: 272_000
    },

    // OpenAI GPT-6 Sol and GPT-6 Luna (developers.openai.com/api/docs/pricing, read 2026-09-22).
    // Sol: $2/$10 short, $4/$15 long, cache hits $0.20/$0.40 — half what GPT-5.6 Sol cost.
    // Luna: $0.10/$0.50 short, $0.20/$0.75 long, cache hits $0.01/$0.02 — also halved.
    // As with Astra, OpenAI's table doesn't restate the short/long boundary, so we keep the
    // 272k threshold the 5.6 siblings use. Cache WRITES (Sol $2.50/$5, Luna $0.125/$0.25) are
    // not modelled: OpenAI caching is automatic and the API only reports hits.
    // GPT-6.1 Sol (2026-09-29) kept GPT-6 Sol's rates exactly, cache writes included.
    // Re-read 2026-10-26 with the Terra launch: the page now lists Sol's cache hit at $0.10
    // (5% of input, the same share as Terra), not the $0.20 recorded on 2026-09-22; Astra and
    // Luna still show 10%. Followed the page.
    [SupportedAiModels[LLM_CONSTANTS.GPT_SOL].modelApiName]: {
        inputPrice: 2.000,
        outputPrice: 10.000,
        cacheHitPrice: 0.100,
        extendedContextInputPrice: 4.000,
        extendedContextOutputPrice: 15.000,
        extendedContextCacheHitPrice: 0.200,
        extendedContextThresholdTokens: 272_000
    },
    // GPT-6.1 Terra (developers.openai.com/api/docs/pricing, read 2026-10-26): $1/$5 short,
    // cache hits $0.05 (5% of input, like 6.1 Sol), 30m/12h cache writes $1.25/$2.50 — not
    // modelled, see above. The page's "Long" tab is rendered client-side and embeds no 6.x
    // rows, so the long-context rates follow the family rule every other entry here uses
    // (2x input, 1.5x output, 2x cache hit) over the same 272k threshold.
    [SupportedAiModels[LLM_CONSTANTS.GPT].modelApiName]: {
        inputPrice: 1.000,
        outputPrice: 5.000,
        cacheHitPrice: 0.050,
        extendedContextInputPrice: 2.000,
        extendedContextOutputPrice: 7.500,
        extendedContextCacheHitPrice: 0.100,
        extendedContextThresholdTokens: 272_000
    },
    [SupportedAiModels[LLM_CONSTANTS.GPT_MINI].modelApiName]: {
        inputPrice: 0.100,
        outputPrice: 0.500,
        cacheHitPrice: 0.010,
        extendedContextInputPrice: 0.200,
        extendedContextOutputPrice: 0.750,
        extendedContextCacheHitPrice: 0.020,
        extendedContextThresholdTokens: 272_000
    },

    // DeepSeek V4 models
    // Peak-valley pricing landed: these are the new base (off-peak) rates with a 2× surcharge
    // during UTC 1:00–4:00 and 6:00–10:00, effective provider-side 2026-08-16 16:00 UTC
    // (api-docs.deepseek.com/quick_start/pricing, fetched 2026-08-13; rates re-confirmed
    // 2026-08-30). Since 2026-08-23 00:00 Beijing (UTC+8) the surcharge is weekdays-only:
    // Saturday and Sunday Beijing time bill at the off-peak rate all day (DeepSeek notice email).
    // 2026-09-12: Flash is V4.1 at lower rates ($0.15 / $0.60, cache hit $0.003 off-peak);
    // Pro rates unchanged and DeepSeek confirmed Pro stays available past 2026-09-14.
    [SupportedAiModels[LLM_CONSTANTS.DEEPSEEK_FLASH].modelApiName]: {
        inputPrice: 0.15,
        outputPrice: 0.60,
        cacheHitPrice: 0.003,
        peakPricing: DEEPSEEK_PEAK_SCHEDULE
    },
    [SupportedAiModels[LLM_CONSTANTS.DEEPSEEK_PRO].modelApiName]: {
        inputPrice: 0.66,
        outputPrice: 1.98,
        cacheHitPrice: 0.022,
        peakPricing: DEEPSEEK_PEAK_SCHEDULE
    },

    // Kimi/Moonshot models (platform.kimi.ai/docs/pricing/chat, 2026-10-23). Cache writes
    // ($2/$4 per M for 5m/1h on Pro, $4/$8 on Highspeed) are not modelled: Moonshot caches
    // automatically and only reports hits.
    [SupportedAiModels[LLM_CONSTANTS.KIMI].modelApiName]: {
        inputPrice: 2.00,
        outputPrice: 10.00,
        cacheHitPrice: 0.20
    },
    [SupportedAiModels[LLM_CONSTANTS.KIMI_HIGHSPEED].modelApiName]: {
        inputPrice: 4.00,
        outputPrice: 20.00,
        cacheHitPrice: 0.20
    },

    // Z.AI models
    [SupportedAiModels[LLM_CONSTANTS.GLM].modelApiName]: {
        inputPrice: 1.4,
        outputPrice: 4.4,
        cacheHitPrice: 0.26
    },
    // GLM-5.3-Flash list rates (docs.z.ai/guides/overview/pricing, 2026-08-30). The page shows a
    // 50% promo ($0.075 / $0.015 / $0.25) ending 2026-09-09 24:00 UTC+8; we bill the list rate
    // rather than track a ten-day promo.
    [SupportedAiModels[LLM_CONSTANTS.GLM_FLASH].modelApiName]: {
        inputPrice: 0.15,
        outputPrice: 0.50,
        cacheHitPrice: 0.03
    },

    // Anthropic models
    [SupportedAiModels[LLM_CONSTANTS.CLAUDE_FABLE].modelApiName]: {
        // Full 1M context window at standard pricing (no extended-context premium).
        // Fable 5.1 (2026-09-02): same $10/$50 as Fable 5, but cache reads dropped to $0.25/MTok.
        inputPrice: 10.0,
        outputPrice: 50.0,
        cacheHitPrice: 0.25
    },
    [SupportedAiModels[LLM_CONSTANTS.CLAUDE_OPUS].modelApiName]: {
        // Opus 5.5 (2026-09-22): $4/$20, down from Opus 5's $5/$25. Cache reads are 5% of input
        // here, not the usual 10% — $0.20, not $0.40. Cache WRITES ($5 at 5m, $8 at 1h) are not
        // modelled: calculateCost bills every uncached prompt token at inputPrice, so a write is
        // under-billed by the 1.25x/2x premium. Pre-existing for every Anthropic model.
        inputPrice: 4.0,
        outputPrice: 20.0,
        cacheHitPrice: 0.20
    },
    [SupportedAiModels[LLM_CONSTANTS.CLAUDE_SONNET].modelApiName]: {
        // Sonnet 5.5 (2026-09-28): same $2/$10 and $0.20 cache reads as Sonnet 5.
        inputPrice: 2.0,
        outputPrice: 10.0,
        cacheHitPrice: 0.20
    },
    [SupportedAiModels[LLM_CONSTANTS.CLAUDE_HAIKU].modelApiName]: {
        // Haiku 5.5 (2026-10-07): the first Claude with a long-context tier — every rate is 5x
        // for prompts over 100K tokens (cache reads + writes count toward the prompt size,
        // which is what AnthropicAgent passes as inputTokens).
        inputPrice: 0.10,
        outputPrice: 0.50,
        cacheHitPrice: 0.01,
        extendedContextInputPrice: 0.50,
        extendedContextOutputPrice: 2.50,
        extendedContextCacheHitPrice: 0.05,
        extendedContextThresholdTokens: 100_000
    },

    // Google models
    [SupportedAiModels[LLM_CONSTANTS.GEMINI_ARGON].modelApiName]: {
        // Launch pricing (ai.google.dev pricing page, fetched 2026-10-13), one flat tier — no
        // >200K long-context rows, unlike 3.1 Pro. DOUBLES on 2026-12-01 to $4.00 / $20.00 /
        // $0.20 — ACTION NEEDED then. Implicit caching only (explicit caching unsupported),
        // cached input bills at 5% of the input price. Not on Google's free tier or AI Pro plan.
        inputPrice: 2.0,
        outputPrice: 10.0,
        cacheHitPrice: 0.10
    },
    [SupportedAiModels[LLM_CONSTANTS.GEMINI_PRO].modelApiName]: {
        inputPrice: 2.0,
        outputPrice: 12.0,
        cacheHitPrice: 0.20,
        extendedContextInputPrice: 4.0,
        extendedContextOutputPrice: 18.0,
        extendedContextCacheHitPrice: 0.40,
        extendedContextThresholdTokens: 200_000
    },
    [SupportedAiModels[LLM_CONSTANTS.GEMINI_FLASH].modelApiName]: {
        // 3.8 Flash (2026-09-02) launched at the same rates as 3.7. 3.7's launch pricing was
        // scheduled to double to $1.50/$7.50/$0.15 on 2027-01-01 (ai.google.dev pricing page,
        // fetched 2026-08-13) — ACTION NEEDED then: re-check whether 3.8 follows and update.
        // Cache storage cost ($0.50 / 1M tokens per hour) is not tracked here — the
        // schema only models per-token call costs, not time-based storage.
        inputPrice: 0.75,
        outputPrice: 3.75,
        cacheHitPrice: 0.075
    },
    [SupportedAiModels[LLM_CONSTANTS.GEMINI_LITE].modelApiName]: {
        // Cache storage cost ($1.00 / 1M tokens per hour) is not tracked here — the
        // schema only models per-token call costs, not time-based storage.
        inputPrice: 0.30,
        outputPrice: 1.50,
        cacheHitPrice: 0.025
    },

    // Mistral models (mistral.ai/pricing/api, verified 2026-09-18). Cached tokens bill at 10% of
    // the input price (documented on the prompt_cache_key param; no per-model cached prices
    // published). Reasoning tokens are counted inside completion_tokens — no separate
    // reasoning_tokens field — so the output rate already covers the trace.
    [SupportedAiModels[LLM_CONSTANTS.MISTRAL_SMALL].modelApiName]: {
        inputPrice: 0.15,
        outputPrice: 0.6,
        cacheHitPrice: 0.015
    },

    // Grok models. Cached price is per-model on xAI (not a uniform ratio):
    // grok-4.7 is $0.50/M cached vs $2.00/M input, and all rates double for prompts
    // >= 200K tokens, per docs.x.ai/docs/models (re-verified 2026-09-22 for 4.7).
    // 4.7 carries over 4.6's rates unchanged — the bump is capability-only, not a reprice.
    [SupportedAiModels[LLM_CONSTANTS.GROK].modelApiName]: {
        inputPrice: 2.0,
        outputPrice: 6.0,
        cacheHitPrice: 0.50,
        extendedContextInputPrice: 4.0,
        extendedContextOutputPrice: 12.0,
        extendedContextCacheHitPrice: 1.0,
        extendedContextThresholdTokens: 200_000
    },

    // Sakana Fugu (console.sakana.ai/pricing, read 2026-09-20). Base `fugu` (retired 2026-08-04)
    // and `fugu-ultra` (removed 0.19.1) have no entries. Any "orchestration" tokens reported in
    // prompt_tokens_details / completion_tokens_details bill at these same rates — FuguAgent
    // folds them into the token counts before pricing.
    // fugu-max: flat rates, no context tiers.
    [SupportedAiModels[LLM_CONSTANTS.FUGU_MAX].modelApiName]: {
        inputPrice: 2.0,
        outputPrice: 6.0,
        cacheHitPrice: 0.25,
    },

    // Qwen models. Rates from the official pricing page (qwencloud.com/pricing/api, read
    // 2026-08-30 — the page is client-rendered, so it was read by eye, not WebFetch):
    // qwen3.8-max $2/$6 with implicit-cache hits at $0.25; qwen3.8-flash $0.15/$0.47, hits
    // $0.016. Neither has input-length tiers (the tier column is "-" for both). These
    // published cached rates supersede the 20%-of-input rule charged before 2026-08-30; we
    // still don't send explicit cache_control.
    [SupportedAiModels[LLM_CONSTANTS.QWEN_MAX].modelApiName]: {
        inputPrice: 2.0,
        outputPrice: 6.0,
        cacheHitPrice: 0.25
    },
    [SupportedAiModels[LLM_CONSTANTS.QWEN_FLASH].modelApiName]: {
        inputPrice: 0.15,
        outputPrice: 0.47,
        cacheHitPrice: 0.016
    },

    // MiniMax M3.1 Flash. Rates from platform.minimax.io/docs/guides/pricing-paygo (2026-10-27,
    // USD): one tier across the 1M window (M3 had ≤512k / >512k tiers; the page lists none for
    // M3.1 Flash). Caching is automatic (≥512 input tokens), hits reported in
    // prompt_tokens_details.cached_tokens; no write fee listed.
    [SupportedAiModels[LLM_CONSTANTS.MINIMAX].modelApiName]: {
        inputPrice: 0.15,
        outputPrice: 0.60,
        cacheHitPrice: 0.015
    },

    // Meta Muse Spark 1.3, Standard tier. Rates from ai.developer.meta.com/docs/pricing-rate-limits
    // (2026-09-12): no long-context premium at any point of the 1M window; reasoning tokens bill
    // as output; caching is automatic, hits reported in input_tokens_details.cached_tokens.
    [SupportedAiModels[LLM_CONSTANTS.MUSE_SPARK].modelApiName]: {
        inputPrice: 1.25,
        outputPrice: 4.25,
        cacheHitPrice: 0.15
    },
    // Standard mode (Meta Model API pricing page, 2026-10-13); Contributor mode is not offered
    // for Wonder. Cached input at 5% of input.
    [SupportedAiModels[LLM_CONSTANTS.MUSE_WONDER].modelApiName]: {
        inputPrice: 4.0,
        outputPrice: 20.0,
        cacheHitPrice: 0.20
    }
};

/** modelApiNames of hybrid models: their APIs offer a thinking toggle, but the catalog ships them
 *  thinking-only (non-thinking variants retired 2026-08-05). A hybrid model run with thinking on
 *  burns extra reasoning tokens at the output rate, so its effective output price is a multiple
 *  of the sticker price — consumers that budget on price use this to know which models that
 *  applies to. This is hand-maintained: it can no longer be derived from the catalog, since no
 *  non-thinking siblings exist to derive it from. */
const HYBRID_THINKING_API_NAMES = new Set([
    SupportedAiModels[LLM_CONSTANTS.CLAUDE_OPUS].modelApiName,
    SupportedAiModels[LLM_CONSTANTS.CLAUDE_SONNET].modelApiName,
    SupportedAiModels[LLM_CONSTANTS.CLAUDE_HAIKU].modelApiName,
    SupportedAiModels[LLM_CONSTANTS.DEEPSEEK_FLASH].modelApiName,
    SupportedAiModels[LLM_CONSTANTS.DEEPSEEK_PRO].modelApiName,
    SupportedAiModels[LLM_CONSTANTS.GLM].modelApiName,
    SupportedAiModels[LLM_CONSTANTS.GLM_FLASH].modelApiName,
    // Qwen ships thinking-only from day one, but the API's enable_thinking toggle makes these
    // hybrid by the same definition: we force reasoning on, so they carry the multiplier.
    SupportedAiModels[LLM_CONSTANTS.QWEN_MAX].modelApiName,
    SupportedAiModels[LLM_CONSTANTS.QWEN_FLASH].modelApiName,
    // MiniMax left the set 2026-10-27: M3.1 Flash cannot turn thinking off (M3 could).
    // Mistral reasons only when asked (`reasoning_effort`), and we always ask — hybrid by the
    // same definition as Qwen. Added 2026-09-18 when the Mistral entries went thinking-on.
    SupportedAiModels[LLM_CONSTANTS.MISTRAL_SMALL].modelApiName,
]);

/** True for hybrid thinking-only models — the ones whose effective output price is a known
 *  multiple of the sticker price. Always-on reasoning models (GPT-5, Gemini, Grok, Kimi,
 *  Fable) also burn reasoning tokens, but their multiplier hasn't been measured. */
export function isHybridThinkingModel(modelApiName: string): boolean {
    return HYBRID_THINKING_API_NAMES.has(modelApiName);
}

export interface CostCalculationOptions {
    cacheHitTokens?: number;
    contextTokens?: number;
    totalTokens?: number;
    timestamp?: number; // When the request was billed; defaults to now. Only affects peakPricing models.
}

/**
 * Helper function to calculate cost based on model pricing
 * @param modelApiName - The API name of the model
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param options - Additional calculation details (cache hits, context tokens, etc.)
 * @returns Cost in USD
 */
export function calculateModelCost(
    modelApiName: string,
    inputTokens: number,
    outputTokens: number,
    options: CostCalculationOptions = {}
): number {
    const pricing = MODEL_PRICING[modelApiName];

    if (!pricing) {
        console.warn(`No pricing information available for model: ${modelApiName}`);
        return 0;
    }

    // All prices are per million tokens
    const divisor = 1_000_000;

    // Calculate cached vs uncached input tokens
    const cacheHitTokens = Math.max(0, options.cacheHitTokens ?? 0);
    const actualCacheHits = Math.min(cacheHitTokens, inputTokens);
    const uncachedInputTokens = Math.max(0, inputTokens - actualCacheHits);

    // Determine if extended context pricing applies
    const contextTokens = options.contextTokens ?? options.totalTokens ?? inputTokens;
    let activeInputPrice = pricing.inputPrice;
    let activeOutputPrice = pricing.outputPrice;
    let activeCachePrice = pricing.cacheHitPrice ?? pricing.inputPrice;

    if (
        pricing.extendedContextThresholdTokens !== undefined &&
        contextTokens > pricing.extendedContextThresholdTokens
    ) {
        activeInputPrice = pricing.extendedContextInputPrice ?? pricing.inputPrice;
        activeOutputPrice = pricing.extendedContextOutputPrice ?? pricing.outputPrice;
        activeCachePrice = pricing.extendedContextCacheHitPrice ?? pricing.cacheHitPrice ?? activeInputPrice;
    } else if (pricing.cacheHitPrice !== undefined) {
        activeCachePrice = pricing.cacheHitPrice;
    }

    if (
        pricing.peakPricing &&
        isPeakBilling(options.timestamp ?? Date.now(), pricing.peakPricing)
    ) {
        activeInputPrice *= pricing.peakPricing.multiplier;
        activeOutputPrice *= pricing.peakPricing.multiplier;
        activeCachePrice *= pricing.peakPricing.multiplier;
    }

    // Calculate costs
    const uncachedInputCost = (uncachedInputTokens * activeInputPrice) / divisor;
    const cachedInputCost = (actualCacheHits * activeCachePrice) / divisor;
    const outputCost = (outputTokens * activeOutputPrice) / divisor;

    return uncachedInputCost + cachedInputCost + outputCost;
}

/**
 * Returns provider-specific signature fields based on the model's API name prefix.
 * Used when storing messages with thinking signatures from different providers.
 * @param aiType - The model API name (e.g. "claude-sonnet-5-5", "gemini-3.7-flash")
 * @param signature - The thinking signature from the API response (may be undefined)
 * @returns Object with appropriate signature fields for the message
 */
export function getProviderSignatureFields(aiType: string, signature?: string): {
    anthropicThinkingSignature?: string;
    googleThoughtSignature?: string;
    grokEncryptedReasoning?: string;
    metaEncryptedReasoning?: string;
    openaiEncryptedReasoning?: string;
} {
    if (!signature) {
        return {};
    }

    // Check if it's an Anthropic (Claude) model
    if (aiType.startsWith('claude-')) {
        return { anthropicThinkingSignature: signature };
    }

    // Check if it's a Google (Gemini) model
    if (aiType.startsWith('gemini-')) {
        return { googleThoughtSignature: signature };
    }

    // Check if it's an xAI (Grok) model — JSON-serialized encrypted reasoning items
    if (aiType.startsWith('grok')) {
        return { grokEncryptedReasoning: signature };
    }

    // OpenAI — same shape as Grok's: JSON-serialized reasoning items carrying encrypted_content.
    // Matches every GPT picker id (gpt-astra, gpt-sol, gpt, gpt-mini).
    if (aiType.startsWith('gpt')) {
        return { openaiEncryptedReasoning: signature };
    }

    // Meta Muse Spark — same shape as Grok's encrypted reasoning items
    if (aiType.startsWith('muse-')) {
        return { metaEncryptedReasoning: signature };
    }

    // Other providers don't support signatures, return empty
    return {};
}
