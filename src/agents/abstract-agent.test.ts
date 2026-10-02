import { z } from 'zod';
import { AbstractAgent } from './abstract-agent';
import { AIMessage, TokenUsage } from '../types';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../catalog';
import { ModelTimeoutError } from '../errors';

class FakeAgent extends AbstractAgent {
    constructor(
        private readonly behavior: 'usage' | 'no-usage' | 'throw',
        private readonly delayMs: number = 0
    ) {
        super('Fake', 'instruction', 'fake-model', 0, false, SILENT_LOGGING);
    }

    private async respond(): Promise<[string, string, TokenUsage?, string?]> {
        if (this.delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }
        if (this.behavior === 'throw') {
            throw new Error('provider exploded');
        }
        const usage: TokenUsage | undefined = this.behavior === 'usage'
            ? { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.001 }
            : undefined;
        return ['{"reply": "hi"}', '', usage];
    }

    protected async doAskWithZodSchema<T>(_schema: z.ZodSchema<T>, _messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        const [content, thinking, usage, sig] = await this.respond();
        return [JSON.parse(content) as T, thinking, usage, sig];
    }

    protected async doAskText(_messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        return this.respond();
    }
}

const MESSAGES: AIMessage[] = [{ role: 'user', content: 'hello' }];

describe('AbstractAgent ask wrappers (duration stamping)', () => {
    it('stamps durationMs onto the TokenUsage returned by askText', async () => {
        const agent = new FakeAgent('usage', 25);
        const [, , usage] = await agent.askText(MESSAGES);
        expect(usage).toBeDefined();
        expect(usage!.durationMs).toBeGreaterThanOrEqual(20);
        // Original fields untouched
        expect(usage!.inputTokens).toBe(10);
        expect(usage!.costUSD).toBe(0.001);
    });

    it('stamps durationMs via askWithZodSchema too', async () => {
        const agent = new FakeAgent('usage', 25);
        const [result, , usage] = await agent.askWithZodSchema(ReplySchema, MESSAGES);
        expect(result.reply).toBe('hi');
        expect(usage!.durationMs).toBeGreaterThanOrEqual(20);
    });

    it('leaves usage undefined when the provider reported none', async () => {
        const agent = new FakeAgent('no-usage');
        const [, , usage] = await agent.askText(MESSAGES);
        expect(usage).toBeUndefined();
    });

    it('attaches durationMs to thrown errors and rethrows them unchanged', async () => {
        const agent = new FakeAgent('throw', 25);
        try {
            await agent.askText(MESSAGES);
            fail('expected throw');
        } catch (error: any) {
            expect(error.message).toBe('provider exploded');
            expect(error.durationMs).toBeGreaterThanOrEqual(20);
        }
    });
});

describe('AbstractAgent request timeout', () => {
    it('defaults to DEFAULT_REQUEST_TIMEOUT_MS', () => {
        expect(new FakeAgent('usage').requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    });

    it('throws ModelTimeoutError when the provider does not answer in time', async () => {
        const agent = new FakeAgent('usage', 200);
        agent.requestTimeoutMs = 30;
        try {
            await agent.askText(MESSAGES);
            fail('expected throw');
        } catch (error: any) {
            expect(error).toBeInstanceOf(ModelTimeoutError);
            expect(error.timeoutMs).toBe(30);
            expect(error.modelType).toBe('fake-model');
            expect(error.durationMs).toBeGreaterThanOrEqual(25);
        }
    });

    it('applies to askWithZodSchema too', async () => {
        const agent = new FakeAgent('usage', 200);
        agent.requestTimeoutMs = 30;
        await expect(agent.askWithZodSchema(ReplySchema, MESSAGES)).rejects.toBeInstanceOf(ModelTimeoutError);
    });

    it('returns normally when the provider answers within the limit', async () => {
        const agent = new FakeAgent('usage', 10);
        agent.requestTimeoutMs = 500;
        const [content] = await agent.askText(MESSAGES);
        expect(content).toBe('{"reply": "hi"}');
    });

    it('passes provider errors through unchanged when they beat the limit', async () => {
        const agent = new FakeAgent('throw', 10);
        agent.requestTimeoutMs = 500;
        await expect(agent.askText(MESSAGES)).rejects.toThrow('provider exploded');
    });
});
