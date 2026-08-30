import { AIMessage } from '../types';
import { SILENT_LOGGING } from '../testing/fixtures';
import { ClaudeAgent } from './anthropic-agent';
import { DeepSeekV2Agent } from './deepseek-v2-agent';
import { Gpt5Agent } from './gpt-5-agent';
import { GoogleAgent } from './google-agent';
import { MistralAgent } from './mistral-agent';
import { GlmAgent } from './glm-agent';
import { QwenAgent } from './qwen-agent';
import { MiniMaxAgent } from './minimax-agent';
import { KimiAgent } from './kimi-agent';
import { GrokAgent } from './grok-agent';

/**
 * Empty-content guard, one per agent (mocked, free).
 *
 * The throw-on-empty inside each agent's askText() is the ONLY thing standing between an
 * empty model response and a blank message reaching the caller — it is what lets a host
 * surface a recoverable error and offer a retry. These cases can't be provoked live
 * (providers can't be made to return nothing) and the "empty response" contract never
 * changes, so a mocked unit test is the right (and only) home for this coverage.
 *
 * Each test constructs the real agent, then swaps its SDK client for a stub that
 * returns an empty completion in the exact shape that agent's askText reads.
 */

const MESSAGES: AIMessage[] = [{ role: 'user', content: 'Say something.' }];

// Empty-completion shapes per client surface.
const openAiChatEmpty = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } } };

type AgentCase = { name: string; make: () => any };

const cases: AgentCase[] = [
  {
    name: 'ClaudeAgent',
    make: () => {
      const agent = new ClaudeAgent('Mira', 'instruction', 'claude-test', 'key', false, SILENT_LOGGING);
      // Non-empty content array, but no usable text -> textParts join is '' -> throws.
      (agent as any).client = { messages: { create: async () => ({ content: [{ type: 'text', text: '' }] }) } };
      return agent;
    },
  },
  {
    name: 'DeepSeekV2Agent',
    make: () => {
      const agent = new DeepSeekV2Agent('Mira', 'instruction', 'deepseek-test', 'key', 0.2, false, SILENT_LOGGING);
      (agent as any).client = openAiChatEmpty;
      return agent;
    },
  },
  {
    name: 'Gpt5Agent',
    make: () => {
      const agent = new Gpt5Agent('Mira', 'instruction', 'gpt-test', 'key', 0.2, false, SILENT_LOGGING);
      (agent as any).client = { responses: { create: async () => ({ output_text: '' }) } };
      return agent;
    },
  },
  {
    name: 'GoogleAgent',
    make: () => {
      const agent = new GoogleAgent('Mira', 'instruction', 'gemini-test', 'key', false, SILENT_LOGGING);
      (agent as any).client = { models: { generateContent: async () => ({ text: '' }) } };
      return agent;
    },
  },
  {
    name: 'MistralAgent',
    make: () => {
      const agent = new MistralAgent('Mira', 'instruction', 'mistral-test', 'key', false, SILENT_LOGGING);
      (agent as any).client = { chat: { complete: async () => ({ choices: [{ message: { content: '' } }] }) } };
      return agent;
    },
  },
  {
    name: 'GlmAgent',
    make: () => {
      const agent = new GlmAgent('Mira', 'instruction', 'glm-test', 'key', 0.2, false, SILENT_LOGGING);
      (agent as any).client = openAiChatEmpty;
      return agent;
    },
  },
  {
    name: 'QwenAgent',
    make: () => {
      const agent = new QwenAgent('Mira', 'instruction', 'qwen-test', 'key', 0.2, false, SILENT_LOGGING);
      (agent as any).client = openAiChatEmpty;
      return agent;
    },
  },
  {
    name: 'MiniMaxAgent',
    make: () => {
      const agent = new MiniMaxAgent('Mira', 'instruction', 'minimax-test', 'key', 0.2, false, SILENT_LOGGING);
      (agent as any).client = openAiChatEmpty;
      return agent;
    },
  },
  {
    name: 'KimiAgent',
    make: () => {
      const agent = new KimiAgent('Mira', 'instruction', 'kimi-test', 'key', 0.2, false, SILENT_LOGGING);
      (agent as any).client = openAiChatEmpty;
      return agent;
    },
  },
  {
    name: 'GrokAgent',
    make: () => {
      const agent = new GrokAgent('Mira', 'instruction', 'grok-test', 'key', 0.2, false, SILENT_LOGGING);
      // Responses API surface: message item present but its output_text is empty.
      (agent as any).client = {
        responses: {
          create: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }] }),
        },
      };
      return agent;
    },
  },
];

describe('askText empty-content guard', () => {
  cases.forEach(({ name, make }) => {
    it(`${name}.askText throws on an empty model response`, async () => {
      const agent = make();
      await expect(agent.askText(MESSAGES)).rejects.toThrow();
    });
  });
});
