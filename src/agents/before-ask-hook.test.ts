import { z } from 'zod';
import { AbstractAgent, setBeforeAskHook } from './abstract-agent';
import { AIMessage, TokenUsage } from '../types';

class StubAgent extends AbstractAgent {
    calls = 0;
    constructor() { super('stub', 'instruction', 'stub-model', 0); }
    protected async doAskWithZodSchema<T>(_schema: z.ZodSchema<T>, _messages: AIMessage[]): Promise<[T, string, TokenUsage?, string?]> {
        this.calls++;
        return [{} as T, '', undefined, undefined];
    }
    protected async doAskText(_messages: AIMessage[]): Promise<[string, string, TokenUsage?, string?]> {
        this.calls++;
        return ['ok', '', undefined, undefined];
    }
}

afterEach(() => setBeforeAskHook());

describe('setBeforeAskHook', () => {
    it('runs before both ask paths with the agent, and sees its userId', async () => {
        const seen: (string | undefined)[] = [];
        setBeforeAskHook(agent => { seen.push(agent.userId); });
        const agent = new StubAgent();
        agent.userId = 'user@example.com';
        await agent.askText([]);
        await agent.askWithZodSchema(z.object({}), []);
        expect(seen).toEqual(['user@example.com', 'user@example.com']);
        expect(agent.calls).toBe(2);
    });

    it('a throwing hook refuses the call before the provider is reached', async () => {
        setBeforeAskHook(async () => { throw new Error('budget exhausted'); });
        const agent = new StubAgent();
        await expect(agent.askText([])).rejects.toThrow('budget exhausted');
        await expect(agent.askWithZodSchema(z.object({}), [])).rejects.toThrow('budget exhausted');
        expect(agent.calls).toBe(0);
    });

    it('no hook installed: asks proceed', async () => {
        const agent = new StubAgent();
        await expect(agent.askText([])).resolves.toEqual(['ok', '', undefined, undefined]);
    });
});
