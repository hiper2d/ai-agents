import { z } from 'zod';
import { extractFirstJsonObject, parseAndValidateLlmJson } from './json-response-parser';
import { ReplySchema } from './testing/fixtures';

/** A two-field schema with no `reply`, so prose can't be wrapped into it. */
const PickSchema = z.object({
    who: z.string().describe('The name you pick, verbatim from the list'),
    why: z.string().describe('One sentence on why'),
});

describe('extractFirstJsonObject', () => {
    it('extracts a bare object', () => {
        expect(extractFirstJsonObject('{"a": 1}')).toEqual({ a: 1 });
    });

    it('extracts an object embedded in prose', () => {
        expect(extractFirstJsonObject('Sure! Here is my answer: {"a": 1} hope it helps'))
            .toEqual({ a: 1 });
    });

    it('handles braces inside string values', () => {
        expect(extractFirstJsonObject('prefix {"reply": "smile :} and {wave}"} suffix'))
            .toEqual({ reply: 'smile :} and {wave}' });
    });

    it('handles escaped quotes inside strings', () => {
        expect(extractFirstJsonObject('x {"reply": "he said \\"hi {there}\\""} y'))
            .toEqual({ reply: 'he said "hi {there}"' });
    });

    it('skips an unparseable candidate and finds a later object', () => {
        expect(extractFirstJsonObject('{not json} but {"a": 2} works'))
            .toEqual({ a: 2 });
    });

    it('returns null when there is no object', () => {
        expect(extractFirstJsonObject('no json here')).toBeNull();
    });

    it('returns null for truncated JSON', () => {
        expect(extractFirstJsonObject('{"reply": "cut off mid-')).toBeNull();
    });
});

describe('parseAndValidateLlmJson', () => {
    it('parses strict valid JSON', () => {
        expect(parseAndValidateLlmJson('{"reply": "hello"}', ReplySchema))
            .toEqual({ reply: 'hello' });
    });

    it('parses fenced JSON', () => {
        expect(parseAndValidateLlmJson('```json\n{"reply": "hello"}\n```', ReplySchema))
            .toEqual({ reply: 'hello' });
    });

    it('recovers JSON wrapped in prose (Grok prose-preamble case)', () => {
        const raw = 'Max, calling it now: {"who": "Cato", "why": "too quiet"} — final answer.';
        expect(parseAndValidateLlmJson(raw, PickSchema))
            .toEqual({ who: 'Cato', why: 'too quiet' });
    });

    it('unwraps a JSON string wrapped in quotes (Gemini quirk)', () => {
        const raw = '"{\\"reply\\": \\"hello\\"}"';
        expect(parseAndValidateLlmJson(raw, ReplySchema))
            .toEqual({ reply: 'hello' });
    });

    it('flattens a nested reply object to a string (Mistral quirk)', () => {
        const raw = '{"reply": {"thought": "hmm", "speech": "hi"}}';
        const result = parseAndValidateLlmJson(raw, ReplySchema);
        expect(typeof result.reply).toBe('string');
        expect(result.reply).toContain('"speech": "hi"');
    });

    it('re-braces an object body missing both outer braces (MiniMax-M3 case)', () => {
        const raw = '"who": "Luke",\n  "why": "Luke\'s flip is the freshest suspicious pattern"';
        expect(parseAndValidateLlmJson(raw, PickSchema))
            .toEqual({ who: 'Luke', why: "Luke's flip is the freshest suspicious pattern" });
    });

    it('re-braces an object body missing only the opening brace', () => {
        const raw = '"who": "Luke", "why": "kept the closing brace"}';
        expect(parseAndValidateLlmJson(raw, PickSchema))
            .toEqual({ who: 'Luke', why: 'kept the closing brace' });
    });

    it('wraps raw prose as reply for reply-shaped schemas', () => {
        const result = parseAndValidateLlmJson('I am just talking in character.', ReplySchema);
        expect(result).toEqual({ reply: 'I am just talking in character.' });
    });

    it('throws a parse error for prose with a non-reply schema', () => {
        expect(() => parseAndValidateLlmJson('just prose, no json', PickSchema))
            .toThrow(/Failed to parse JSON response/);
    });

    it('throws a validation error for valid JSON of the wrong shape', () => {
        expect(() => parseAndValidateLlmJson('{"who": 42}', PickSchema))
            .toThrow(/Response validation failed/);
    });

    it('throws a parse error for truncated JSON (DeepSeek truncation case)', () => {
        expect(() => parseAndValidateLlmJson('{"who": "Cato", "why": "because he', PickSchema))
            .toThrow(/Failed to parse JSON response/);
    });

    it('reports recoveries through the log callback', () => {
        const logs: string[] = [];
        parseAndValidateLlmJson('preamble {"reply": "ok"}', ReplySchema, (m) => logs.push(m));
        expect(logs.some(m => m.includes('Recovered JSON'))).toBe(true);
    });
});
