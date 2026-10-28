import { z } from 'zod';
import { AbstractAgent, setBeforeAskHook, setRetryHook } from './abstract-agent';
import { AIMessage, TokenUsage } from '../types';
import { SILENT_LOGGING } from '../testing/fixtures';
import { ModelInvalidResponseError, ModelTimeoutError } from '../errors';

/**
 * The invalidResponseRetries policy in AbstractAgent's template methods: an empty or
 * malformed answer is re-sent, everything else is not, and the retry hook sees each
 * re-send and gets its settle function run once the ask is over.
 */

type Outcome = { ok: string } | { throw: Error };

class ScriptedAgent extends AbstractAgent {
    calls = 0;
    constructor(private readonly script: Outcome[], retries = 0) {
        super('Mira', 'instruction', 'scripted-model', 0, false, SILENT_LOGGING);
        this.invalidResponseRetries = retries;
    }
    private next(): [string, string, TokenUsage?, string?] {
        const step = this.script[Math.min(this.calls, this.script.length - 1)];
        this.calls++;
        if ('throw' in step) throw step.throw;
        return [step.ok, '', { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0.001 }];
    }
    protected async doAskWithZodSchema<T>(_schema: z.ZodSchema<T>, _messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        const [content, thinking, usage, sig] = this.next();
        return [{ reply: content } as T, thinking, usage, sig];
    }
    protected async doAskText(_messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        return this.next();
    }
}

const MESSAGES: AIMessage[] = [{ role: 'user', content: 'hello' }];
const empty = () => new ModelInvalidResponseError('scripted-model', 'Empty or undefined response');
const malformed = () => new ModelInvalidResponseError('scripted-model', 'Response validation failed: reply required');

afterEach(() => {
    setRetryHook();
    setBeforeAskHook();
});

describe('invalidResponseRetries', () => {
    it('default 0: the first invalid response is thrown, nothing is re-sent', async () => {
        const agent = new ScriptedAgent([{ throw: empty() }, { ok: 'late' }]);
        await expect(agent.askText(MESSAGES)).rejects.toBeInstanceOf(ModelInvalidResponseError);
        expect(agent.calls).toBe(1);
    });

    it('1: an empty answer is re-sent once and the second answer is returned, on both ask paths', async () => {
        const text = new ScriptedAgent([{ throw: empty() }, { ok: 'second try' }], 1);
        const [content, , usage] = await text.askText(MESSAGES);
        expect(content).toBe('second try');
        expect(usage?.durationMs).toBeDefined();
        expect(text.calls).toBe(2);

        const schema = new ScriptedAgent([{ throw: malformed() }, { ok: 'parsed' }], 1);
        const [result] = await schema.askWithZodSchema(z.object({ reply: z.string() }), MESSAGES);
        expect(result).toEqual({ reply: 'parsed' });
        expect(schema.calls).toBe(2);
    });

    it('1: two invalid answers in a row throw the second one, stamped with the retry count', async () => {
        const second = malformed();
        const agent = new ScriptedAgent([{ throw: empty() }, { throw: second }], 1);
        await expect(agent.askText(MESSAGES)).rejects.toBe(second);
        expect(second.retries).toBe(1);
        expect(agent.calls).toBe(2);
    });

    it('never re-sends a truncated response, a timeout, or a plain error', async () => {
        const truncated = new ScriptedAgent([{ throw: new ModelInvalidResponseError('scripted-model', 'cap hit', true) }, { ok: 'x' }], 1);
        await expect(truncated.askText(MESSAGES)).rejects.toThrow('cap hit');
        expect(truncated.calls).toBe(1);

        const timeout = new ScriptedAgent([{ throw: new ModelTimeoutError('scripted-model', 10) }, { ok: 'x' }], 1);
        await expect(timeout.askText(MESSAGES)).rejects.toBeInstanceOf(ModelTimeoutError);
        expect(timeout.calls).toBe(1);

        const plain = new ScriptedAgent([{ throw: new Error('HTTP 503') }, { ok: 'x' }], 1);
        await expect(plain.askText(MESSAGES)).rejects.toThrow('HTTP 503');
        expect(plain.calls).toBe(1);
    });

    it('the retry hook is told about each re-send and its settle function runs once the ask is over', async () => {
        const events: string[] = [];
        setRetryHook(({ agent, model, error, attempt }) => {
            events.push(`retry ${attempt} ${agent.name} ${model}: ${error.message}`);
            return () => { events.push('settled'); };
        });
        const agent = new ScriptedAgent([{ throw: empty() }, { ok: 'fine' }], 1);
        await agent.askText(MESSAGES);
        expect(events).toEqual(['retry 1 Mira scripted-model: scripted-model failed to produce a valid response: Empty or undefined response', 'settled']);

        events.length = 0;
        const failing = new ScriptedAgent([{ throw: empty() }, { throw: empty() }], 1);
        await expect(failing.askText(MESSAGES)).rejects.toBeInstanceOf(ModelInvalidResponseError);
        expect(events).toEqual([expect.stringMatching(/^retry 1/), 'settled']);
    });

    it('a throwing retry hook is ignored and the re-send still happens', async () => {
        setRetryHook(async () => { throw new Error('ui down'); });
        const agent = new ScriptedAgent([{ throw: empty() }, { ok: 'fine' }], 1);
        await expect(agent.askText(MESSAGES)).resolves.toEqual(['fine', '', expect.objectContaining({ costUSD: 0.001 })]);
        expect(agent.calls).toBe(2);
    });

    it('the before-ask hook runs again for the re-send — it is a new paid call', async () => {
        let guarded = 0;
        setBeforeAskHook(() => { guarded++; });
        const agent = new ScriptedAgent([{ throw: empty() }, { ok: 'fine' }], 1);
        await agent.askText(MESSAGES);
        expect(guarded).toBe(2);
    });
});
