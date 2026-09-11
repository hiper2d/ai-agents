import {
    applySpend,
    BudgetController,
    BudgetExceededError,
    evaluateBudget,
    firstRefusal,
    InMemorySpendStore,
    isBudgetExceededError,
    ledgerSpend,
    periodEnd,
    periodKey,
} from './index';

// 2026-09-11T15:30:00Z — a Friday, mid-month, well away from any boundary.
const T = Date.UTC(2026, 8, 11, 15, 30, 0);

describe('periodKey / periodEnd', () => {
    it('keys days and months in UTC', () => {
        expect(periodKey(T, 'day')).toBe('2026-09-11');
        expect(periodKey(T, 'month')).toBe('2026-09');
    });

    it('uses the UTC date, not the local one, right before midnight', () => {
        const lateUtc = Date.UTC(2026, 8, 11, 23, 59, 59);
        expect(periodKey(lateUtc, 'day')).toBe('2026-09-11');
        expect(periodKey(lateUtc + 1000, 'day')).toBe('2026-09-12');
    });

    it('resets at the next UTC midnight / first of next month', () => {
        expect(new Date(periodEnd(T, 'day')).toISOString()).toBe('2026-09-12T00:00:00.000Z');
        expect(new Date(periodEnd(T, 'month')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    });

    it('rolls the year over in December', () => {
        const dec = Date.UTC(2026, 11, 31, 12);
        expect(periodKey(dec, 'month')).toBe('2026-12');
        expect(new Date(periodEnd(dec, 'day')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
        expect(new Date(periodEnd(dec, 'month')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });
});

describe('applySpend', () => {
    it('starts a ledger from nothing', () => {
        expect(applySpend(undefined, { window: 'day', amountUSD: 0.25, bucket: 'free', timestamp: T }))
            .toEqual({ period: '2026-09-11', totalUSD: 0.25, buckets: { free: 0.25 } });
    });

    it('accumulates within the same period, per bucket and in total', () => {
        const a = applySpend(null, { window: 'day', amountUSD: 1, bucket: 'free', timestamp: T });
        const b = applySpend(a, { window: 'day', amountUSD: 0.5, bucket: 'paid', timestamp: T + 60_000 });
        expect(b).toEqual({ period: '2026-09-11', totalUSD: 1.5, buckets: { free: 1, paid: 0.5 } });
    });

    it('overwrites, not appends, when the period has moved on', () => {
        const yesterday = applySpend(null, { window: 'day', amountUSD: 4.99, bucket: 'free', timestamp: T });
        const today = applySpend(yesterday, { window: 'day', amountUSD: 0.1, bucket: 'free', timestamp: periodEnd(T, 'day') });
        expect(today).toEqual({ period: '2026-09-12', totalUSD: 0.1, buckets: { free: 0.1 } });
    });

    it('records to the total only when no bucket is given', () => {
        expect(applySpend(null, { window: 'month', amountUSD: 2, timestamp: T }))
            .toEqual({ period: '2026-09', totalUSD: 2, buckets: {} });
    });

    it('ignores non-positive amounts but still normalizes to the current period', () => {
        const stale = { period: '2026-09-10', totalUSD: 3, buckets: { free: 3 } };
        expect(applySpend(stale, { window: 'day', amountUSD: 0, timestamp: T }))
            .toEqual({ period: '2026-09-11', totalUSD: 0, buckets: {} });
        expect(applySpend(stale, { window: 'day', amountUSD: -1, timestamp: T }).totalUSD).toBe(0);
    });

    it('rounds to 6 decimals and does not mutate its input', () => {
        const input = { period: '2026-09-11', totalUSD: 0.1, buckets: { free: 0.1 } };
        const out = applySpend(input, { window: 'day', amountUSD: 0.2, bucket: 'free', timestamp: T });
        expect(out.totalUSD).toBe(0.3);
        expect(out.buckets.free).toBe(0.3);
        expect(input).toEqual({ period: '2026-09-11', totalUSD: 0.1, buckets: { free: 0.1 } });
    });

    it('tolerates a partial ledger missing buckets', () => {
        expect(applySpend({ period: '2026-09-11', totalUSD: 1 } as any, { window: 'day', amountUSD: 1, bucket: 'free', timestamp: T }))
            .toEqual({ period: '2026-09-11', totalUSD: 2, buckets: { free: 1 } });
    });
});

describe('ledgerSpend', () => {
    const ledger = { period: '2026-09-11', totalUSD: 1.5, buckets: { free: 1, paid: 0.5 } };

    it('reads the total or one bucket for the current period', () => {
        expect(ledgerSpend(ledger, 'day', T)).toBe(1.5);
        expect(ledgerSpend(ledger, 'day', T, 'free')).toBe(1);
        expect(ledgerSpend(ledger, 'day', T, 'nope')).toBe(0);
    });

    it('is 0 for a missing or stale ledger', () => {
        expect(ledgerSpend(undefined, 'day', T)).toBe(0);
        expect(ledgerSpend(ledger, 'day', periodEnd(T, 'day'))).toBe(0);
        // A day ledger asked about as a month ledger has the wrong key → stale.
        expect(ledgerSpend(ledger, 'month', T)).toBe(0);
    });
});

describe('evaluateBudget', () => {
    it('allows below the limit and reports the remainder and reset', () => {
        const v = evaluateBudget(3.2, { window: 'day', limitUSD: 5, bucket: 'free' }, T);
        expect(v).toEqual({
            allowed: true, window: 'day', bucket: 'free', limitUSD: 5, spentUSD: 3.2, remainingUSD: 1.8,
            resetsAt: Date.UTC(2026, 8, 12)
        });
    });

    it('refuses at exactly the limit, not just above it', () => {
        expect(evaluateBudget(5, { window: 'day', limitUSD: 5 }, T).allowed).toBe(false);
        expect(evaluateBudget(5.01, { window: 'day', limitUSD: 5 }, T).allowed).toBe(false);
        expect(evaluateBudget(4.999999, { window: 'day', limitUSD: 5 }, T).allowed).toBe(true);
    });

    it('clamps the remainder at zero once overspent', () => {
        expect(evaluateBudget(7, { window: 'month', limitUSD: 5 }, T).remainingUSD).toBe(0);
    });

    it('treats a non-finite limit as unlimited', () => {
        const v = evaluateBudget(1e9, { window: 'month', limitUSD: Number.POSITIVE_INFINITY }, T);
        expect(v.allowed).toBe(true);
        expect(v.remainingUSD).toBe(Number.POSITIVE_INFINITY);
    });

    it('a zero limit refuses everything', () => {
        expect(evaluateBudget(0, { window: 'day', limitUSD: 0 }, T).allowed).toBe(false);
    });
});

describe('firstRefusal + BudgetExceededError', () => {
    it('returns the first refusing verdict in order', () => {
        const day = evaluateBudget(1, { window: 'day', limitUSD: 5 }, T);
        const month = evaluateBudget(20, { window: 'month', limitUSD: 20 }, T);
        expect(firstRefusal([day, month])).toBe(month);
        expect(firstRefusal([day])).toBeUndefined();
    });

    it('carries the verdict and a readable default message', () => {
        const v = evaluateBudget(5, { window: 'day', limitUSD: 5 }, T);
        const err = new BudgetExceededError(v, 'user@example.com');
        expect(err.name).toBe('BudgetExceededError');
        expect(err.verdict).toBe(v);
        expect(err.subject).toBe('user@example.com');
        expect(err.message).toBe('daily budget of $5 exhausted ($5 spent); resets at 2026-09-12T00:00:00.000Z');
        expect(isBudgetExceededError(err)).toBe(true);
        expect(isBudgetExceededError(new Error('daily budget'))).toBe(false);
    });

    it('accepts a custom message', () => {
        const v = evaluateBudget(5, { window: 'day', limitUSD: 5 }, T);
        expect(new BudgetExceededError(v, undefined, 'custom').message).toBe('custom');
    });
});

describe('BudgetController', () => {
    function make(limits = [{ window: 'day' as const, limitUSD: 1 }, { window: 'month' as const, limitUSD: 3 }]) {
        let now = T;
        const store = new InMemorySpendStore();
        const controller = new BudgetController(store, { limits, bucket: 'free', clock: () => now });
        return { controller, store, advance: (ms: number) => { now += ms; } };
    }

    it('records to every limited window and checks them', async () => {
        const { controller, store } = make();
        await controller.record('u', 0.4);
        await controller.record('u', 0.4);
        const ledgers = await store.read('u');
        expect(ledgers.day).toEqual({ period: '2026-09-11', totalUSD: 0.8, buckets: { free: 0.8 } });
        expect(ledgers.month).toEqual({ period: '2026-09', totalUSD: 0.8, buckets: { free: 0.8 } });
        const [day, month] = await controller.check('u');
        expect(day.remainingUSD).toBe(0.2);
        expect(month.remainingUSD).toBe(2.2);
        await expect(controller.assertWithinBudget('u')).resolves.toBeUndefined();
    });

    it('refuses once a window is exhausted and writes nothing on refusal', async () => {
        const { controller, store } = make();
        await controller.record('u', 1); // exactly at the daily cap
        await expect(controller.assertWithinBudget('u')).rejects.toBeInstanceOf(BudgetExceededError);
        await expect(controller.record('u', 0.01)).rejects.toMatchObject({ verdict: { window: 'day', spentUSD: 1 } });
        expect((await store.read('u')).day?.totalUSD).toBe(1);
    });

    it('lets the subject through again after the window rolls', async () => {
        const { controller, advance } = make();
        await controller.record('u', 1);
        advance(24 * 60 * 60 * 1000);
        await expect(controller.assertWithinBudget('u')).resolves.toBeUndefined();
        await controller.record('u', 0.5);
        const [day, month] = await controller.check('u');
        expect(day.spentUSD).toBe(0.5);   // fresh day
        expect(month.spentUSD).toBe(1.5); // month keeps accumulating
    });

    it('the monthly ceiling bites even when each day is under the daily cap', async () => {
        const { controller, advance } = make();
        for (let i = 0; i < 3; i++) {
            await controller.record('u', 1);
            advance(24 * 60 * 60 * 1000);
        }
        await expect(controller.assertWithinBudget('u')).rejects.toMatchObject({ verdict: { window: 'month', spentUSD: 3 } });
    });

    it('keeps subjects apart', async () => {
        const { controller } = make();
        await controller.record('a', 1);
        await expect(controller.assertWithinBudget('b')).resolves.toBeUndefined();
    });
});
