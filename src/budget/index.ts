/**
 * Budget control for agent spend — pure and storage-agnostic.
 *
 * The problem this solves: an app that runs LLM/voice/image calls on its own keys needs
 * to bound what one subject (a user, a tenant, a job) can spend per UTC day or month, and
 * needs the check to be cheap enough to run before EVERY call. The pieces:
 *
 * - `periodKey` / `periodEnd`: UTC window keys (`YYYY-MM-DD`, `YYYY-MM`) and reset times.
 * - `SpendLedger` + `applySpend`: an O(1) rolling ledger for one window. It is overwritten,
 *   not appended, when the period changes, so the persisted record never grows; history
 *   belongs in your per-request stats, not here.
 * - `evaluateBudget`: the verdict. Pure, no I/O, no throwing.
 * - `BudgetExceededError`: what to throw when a verdict refuses, carrying the verdict so
 *   the caller can render "come back at <resetsAt>" instead of treating it as a provider
 *   failure.
 * - `BudgetController` over a `SpendStore`: batteries-included wrapper for projects that
 *   do not need to fold the ledger into their own database transaction. Apps that do
 *   (the werewolf app charges the user, updates the game and writes a stats row in one
 *   Firestore transaction) use the pure functions directly inside that transaction.
 *
 * Amounts are USD, rounded to 6 decimals like the rest of the cost accounting.
 */

export type SpendWindow = 'day' | 'month';

/** Where the money went; free-form beyond the common kinds so apps can add their own. */
export type SpendKind = 'llm' | 'image' | 'tts' | 'stt' | (string & {});

function round6(n: number): number {
    return parseFloat((Number(n) || 0).toFixed(6));
}

/** UTC key for the window containing `timestamp`: `2026-09-11` for a day, `2026-09` for a month. */
export function periodKey(timestamp: number, window: SpendWindow): string {
    const d = new Date(timestamp);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    if (window === 'month') {
        return `${y}-${m}`;
    }
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** First millisecond of the window after the one containing `timestamp` — i.e. when the budget resets. */
export function periodEnd(timestamp: number, window: SpendWindow): number {
    const d = new Date(timestamp);
    if (window === 'month') {
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Spend recorded for ONE window. `buckets` split the total by whatever the app cares
 * about (tier, model family, feature); the total is authoritative, buckets are a breakdown.
 */
export interface SpendLedger {
    period: string;
    totalUSD: number;
    buckets: Record<string, number>;
}

export interface SpendInput {
    window: SpendWindow;
    amountUSD: number;
    /** Bucket to add the amount to, on top of the total. Omit to update the total only. */
    bucket?: string;
    timestamp?: number;
}

function normalizeLedger(ledger: Partial<SpendLedger> | null | undefined, period: string): SpendLedger {
    if (!ledger || ledger.period !== period) {
        return { period, totalUSD: 0, buckets: {} };
    }
    const buckets: Record<string, number> = {};
    for (const [k, v] of Object.entries(ledger.buckets ?? {})) {
        buckets[k] = round6(v);
    }
    return { period, totalUSD: round6(ledger.totalUSD ?? 0), buckets };
}

/**
 * Pure reducer: add `amountUSD` to the ledger for the window containing `timestamp`.
 * A ledger from an earlier period is discarded and a fresh one started (overwrite
 * semantics), so the persisted record stays O(1). Non-positive amounts return the
 * ledger normalized to the current period without recording anything.
 */
export function applySpend(ledger: Partial<SpendLedger> | null | undefined, input: SpendInput): SpendLedger {
    const timestamp = input.timestamp ?? Date.now();
    const period = periodKey(timestamp, input.window);
    const current = normalizeLedger(ledger, period);
    const amount = round6(input.amountUSD);
    if (!(amount > 0)) {
        return current;
    }
    const buckets = { ...current.buckets };
    if (input.bucket) {
        buckets[input.bucket] = round6((buckets[input.bucket] ?? 0) + amount);
    }
    return { period, totalUSD: round6(current.totalUSD + amount), buckets };
}

/**
 * Spend already recorded in the window containing `timestamp` — the total, or one bucket.
 * A missing ledger or one from another period counts as 0.
 */
export function ledgerSpend(
    ledger: Partial<SpendLedger> | null | undefined,
    window: SpendWindow,
    timestamp: number = Date.now(),
    bucket?: string
): number {
    const current = normalizeLedger(ledger, periodKey(timestamp, window));
    return bucket ? (current.buckets[bucket] ?? 0) : current.totalUSD;
}

export interface BudgetLimit {
    window: SpendWindow;
    /** USD ceiling for the window. `Infinity` (or any non-finite) means unlimited. */
    limitUSD: number;
    /** Which bucket the limit applies to; informational for the verdict, the caller passes the matching spend. */
    bucket?: string;
}

export interface BudgetVerdict {
    allowed: boolean;
    window: SpendWindow;
    bucket?: string;
    limitUSD: number;
    spentUSD: number;
    remainingUSD: number;
    /** Epoch ms when the window rolls over and the spend counts from zero again. */
    resetsAt: number;
}

/**
 * The verdict for one limit given the spend already recorded in its window. Refuses when
 * spent >= limit (a subject exactly at the cap gets no more calls). Pure: no I/O, no throw.
 */
export function evaluateBudget(spentUSD: number, limit: BudgetLimit, timestamp: number = Date.now()): BudgetVerdict {
    const spent = round6(spentUSD);
    const unlimited = !Number.isFinite(limit.limitUSD);
    const remaining = unlimited ? Number.POSITIVE_INFINITY : Math.max(0, round6(limit.limitUSD - spent));
    return {
        allowed: unlimited || spent < limit.limitUSD,
        window: limit.window,
        ...(limit.bucket ? { bucket: limit.bucket } : {}),
        limitUSD: limit.limitUSD,
        spentUSD: spent,
        remainingUSD: remaining,
        resetsAt: periodEnd(timestamp, limit.window)
    };
}

/** The first refusing verdict, or undefined when every window still has room. */
export function firstRefusal(verdicts: BudgetVerdict[]): BudgetVerdict | undefined {
    return verdicts.find(v => !v.allowed);
}

/**
 * Thrown when a budget refuses a call. Not a `ModelError`: nothing was sent to a provider
 * and nothing is retryable until `verdict.resetsAt`. Apps typically subclass it to attach
 * user-facing copy, or map it to their own error at the boundary.
 */
export class BudgetExceededError extends Error {
    public readonly verdict: BudgetVerdict;
    public readonly subject?: string;

    constructor(verdict: BudgetVerdict, subject?: string, message?: string) {
        super(message ?? BudgetExceededError.describe(verdict));
        this.name = 'BudgetExceededError';
        this.verdict = verdict;
        this.subject = subject;
    }

    static describe(v: BudgetVerdict): string {
        const when = v.window === 'day' ? 'daily' : 'monthly';
        return `${when} budget of $${v.limitUSD} exhausted ($${v.spentUSD} spent); resets at ${new Date(v.resetsAt).toISOString()}`;
    }
}

export function isBudgetExceededError(err: unknown): err is BudgetExceededError {
    return err instanceof BudgetExceededError
        || (typeof err === 'object' && err !== null && (err as any).name === 'BudgetExceededError' && !!(err as any).verdict);
}

// ---------------------------------------------------------------------------
// Batteries included: a controller over a pluggable store.
// ---------------------------------------------------------------------------

export type SpendLedgers = Partial<Record<SpendWindow, SpendLedger>>;

/**
 * Persistence for per-subject ledgers. `update` must apply `fn` to the current ledgers
 * and persist the result atomically for that subject (a transaction, a lock, a
 * single-threaded map — whatever the backend offers). If `fn` throws, nothing is written.
 */
export interface SpendStore {
    read(subject: string): Promise<SpendLedgers>;
    update(subject: string, fn: (current: SpendLedgers) => SpendLedgers): Promise<SpendLedgers>;
}

/** Process-local store: fine for tests, CLIs and single-instance jobs. */
export class InMemorySpendStore implements SpendStore {
    private readonly ledgers = new Map<string, SpendLedgers>();

    async read(subject: string): Promise<SpendLedgers> {
        return { ...(this.ledgers.get(subject) ?? {}) };
    }

    async update(subject: string, fn: (current: SpendLedgers) => SpendLedgers): Promise<SpendLedgers> {
        const next = fn({ ...(this.ledgers.get(subject) ?? {}) });
        this.ledgers.set(subject, next);
        return { ...next };
    }
}

export interface BudgetControllerOptions {
    limits: BudgetLimit[];
    /** Bucket every recorded spend is also added to (e.g. the subject's tier). */
    bucket?: string;
    clock?: () => number;
}

/**
 * Check-before, record-after budget control for one set of limits.
 *
 * `assertWithinBudget` is the cheap pre-call guard; `record` re-evaluates inside the
 * store's atomic update so concurrent callers cannot all slip past a nearly-exhausted
 * budget. The overrun that remains is bounded by the calls already in flight when the
 * cap is crossed — state that bound, do not claim the cap is exact.
 */
export class BudgetController {
    private readonly limits: BudgetLimit[];
    private readonly bucket?: string;
    private readonly clock: () => number;

    constructor(private readonly store: SpendStore, options: BudgetControllerOptions) {
        this.limits = options.limits;
        this.bucket = options.bucket;
        this.clock = options.clock ?? (() => Date.now());
    }

    private verdicts(ledgers: SpendLedgers, now: number): BudgetVerdict[] {
        return this.limits.map(limit => {
            const spent = ledgerSpend(ledgers[limit.window], limit.window, now, limit.bucket ?? this.bucket);
            return evaluateBudget(spent, limit, now);
        });
    }

    async check(subject: string): Promise<BudgetVerdict[]> {
        return this.verdicts(await this.store.read(subject), this.clock());
    }

    async assertWithinBudget(subject: string): Promise<void> {
        const refused = firstRefusal(await this.check(subject));
        if (refused) {
            throw new BudgetExceededError(refused, subject);
        }
    }

    /**
     * Record `amountUSD` against every limited window. Re-checks the limits on the
     * ledgers as they are at write time and throws `BudgetExceededError` (writing
     * nothing) if any window is already exhausted.
     */
    async record(subject: string, amountUSD: number): Promise<SpendLedgers> {
        const now = this.clock();
        return this.store.update(subject, current => {
            const refused = firstRefusal(this.verdicts(current, now));
            if (refused) {
                throw new BudgetExceededError(refused, subject);
            }
            const next: SpendLedgers = { ...current };
            for (const limit of this.limits) {
                next[limit.window] = applySpend(current[limit.window], {
                    window: limit.window,
                    amountUSD,
                    bucket: limit.bucket ?? this.bucket,
                    timestamp: now
                });
            }
            return next;
        });
    }
}
