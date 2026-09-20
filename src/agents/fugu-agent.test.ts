import { AIMessage } from '../types';
import { SILENT_LOGGING, ReplySchema } from '../testing/fixtures';
import { FuguAgent, extractFuguTokenUsage } from './fugu-agent';

/**
 * Request-shape and billing guard for the Sakana Fugu agent (mocked, free).
 *
 * Two production defects this pins down (both found 2026-09-20):
 *  - `reasoning_effort` was never sent, and fugu-ultra's server default is `xhigh`: turns took
 *    2.5-4.5 minutes and cost 2-3x what the `high` pin does. Every request must carry the pin.
 *  - Ultra's "orchestration" tokens live outside prompt_tokens / completion_tokens and were
 *    dropped from billing — a 2-4x undercount against Sakana's invoice.
 */

const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

// A real fugu-ultra usage block: 3,418 visible prompt tokens plus 8,956 orchestration input,
// 840 visible completion (601 of them reasoning) plus 2,305 orchestration output.
const ULTRA_USAGE = {
  prompt_tokens: 3418,
  completion_tokens: 840,
  total_tokens: 4258,
  prompt_tokens_details: { cached_tokens: 0, orchestration_input_tokens: 8956, orchestration_input_cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 601, orchestration_output_tokens: 2305 },
};

function makeAgent(model: string, completion: any): { agent: FuguAgent; captured: { params?: any } } {
  const agent = new FuguAgent('Mira', 'instruction', model, 'key', false, SILENT_LOGGING);
  const captured: { params?: any } = {};
  (agent as any).client = {
    chat: { completions: { create: async (params: any) => { captured.params = params; return completion; } } },
  };
  return { agent, captured };
}

const textCompletion = { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: ULTRA_USAGE };
const jsonCompletion = { choices: [{ message: { content: '{"reply":"hello"}' }, finish_reason: 'stop' }], usage: ULTRA_USAGE };

describe('FuguAgent request shape', () => {
  it('askText sends the catalog reasoning_effort (high) for fugu-ultra, never the xhigh server default', async () => {
    const { agent, captured } = makeAgent('fugu-ultra', textCompletion);
    await agent.askText(MESSAGES);

    expect(captured.params.reasoning_effort).toBe('high');
    expect(captured.params.max_tokens).toBe(agent.maxOutputTokens);
    expect(captured.params.response_format).toBeUndefined();
  });

  it('askWithZodSchema sends json mode plus the same effort', async () => {
    const { agent, captured } = makeAgent('fugu-max', jsonCompletion);
    await agent.askWithZodSchema(ReplySchema, MESSAGES);

    expect(captured.params.reasoning_effort).toBe('high');
    expect(captured.params.response_format).toEqual({ type: 'json_object' });
  });

  it('a per-instance override is clamped to what Sakana accepts (high | xhigh | max)', async () => {
    const { agent, captured } = makeAgent('fugu-ultra', textCompletion);
    agent.reasoningEffort = 'low';
    await agent.askText(MESSAGES);
    expect(captured.params.reasoning_effort).toBe('high');

    agent.reasoningEffort = 'max';
    await agent.askText(MESSAGES);
    expect(captured.params.reasoning_effort).toBe('max');
  });
});

describe('Fugu usage accounting', () => {
  it('folds orchestration tokens into the billed input and output', () => {
    const usage = extractFuguTokenUsage('fugu-ultra', { usage: ULTRA_USAGE })!;

    expect(usage.inputTokens).toBe(3418 + 8956);
    expect(usage.outputTokens).toBe(840 + 2305);
    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
    expect(usage.reasoningTokens).toBe(601);
    // $5 in, $30 out per million, no cache hits.
    expect(usage.costUSD).toBeCloseTo((12374 * 5 + 3145 * 30) / 1e6, 6);
  });

  it('bills orchestration cache hits at the cached rate', () => {
    const usage = extractFuguTokenUsage('fugu-ultra', { usage: {
      ...ULTRA_USAGE,
      prompt_tokens_details: { cached_tokens: 1000, orchestration_input_tokens: 8956, orchestration_input_cached_tokens: 4000 },
    } })!;

    expect(usage.cachedInputTokens).toBe(5000);
    expect(usage.costUSD).toBeCloseTo(((12374 - 5000) * 5 + 5000 * 0.5 + 3145 * 30) / 1e6, 6);
  });

  it('is a plain pass-through for fugu-max (no orchestration) and omits a zero reasoning count', () => {
    const usage = extractFuguTokenUsage('fugu-max', { usage: {
      prompt_tokens: 257, completion_tokens: 169, total_tokens: 426,
      prompt_tokens_details: { cached_tokens: 0, orchestration_input_tokens: 0, orchestration_input_cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, orchestration_output_tokens: 0 },
    } })!;

    expect(usage.inputTokens).toBe(257);
    expect(usage.outputTokens).toBe(169);
    expect(usage).not.toHaveProperty('reasoningTokens');
    expect(usage.costUSD).toBeCloseTo((257 * 2 + 169 * 6) / 1e6, 6);
  });

  it('the agent reports the folded usage from a live-shaped completion', async () => {
    const { agent } = makeAgent('fugu-ultra', textCompletion);
    const [, , tokenUsage] = await agent.askText(MESSAGES);
    expect(tokenUsage?.inputTokens).toBe(12374);
    expect(tokenUsage?.outputTokens).toBe(3145);
  });
});
