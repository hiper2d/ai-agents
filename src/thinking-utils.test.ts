import { mergeThinking, stripInlineThinking } from './thinking-utils';

/**
 * Reasoning providers document thinking in a separate field, but models
 * occasionally inline a <think>…</think> block into message.content instead
 * (observed live with qwen-plus, 2026-08). Before stripping existed, that
 * chain of thought (private context included) fell through the lenient JSON
 * parser's wrap-as-reply fallback and became the character's VISIBLE message.
 * All OpenAI-compatible agents route content through stripInlineThinking.
 */
describe('stripInlineThinking', () => {
    it('passes clean content through untouched', () => {
        const { text, thinking } = stripInlineThinking('{"reply":"I choose the left door."}');
        expect(text).toBe('{"reply":"I choose the left door."}');
        expect(thinking).toBe('');
    });

    it('strips a closed think block and keeps the JSON', () => {
        const { text, thinking } = stripInlineThinking('<think>\nMy secret: I am the traitor, allies: Effie, Snow.\n</think>\n{"reply":"Good morning."}');
        expect(text).toBe('{"reply":"Good morning."}');
        expect(thinking).toContain('traitor');
        expect(text).not.toContain('traitor');
    });

    it('recovers from an unterminated think block followed by JSON', () => {
        const { text, thinking } = stripInlineThinking('<think>\nSecret plan about my role...\n{"reply":"Hello everyone."}');
        expect(text).toBe('{"reply":"Hello everyone."}');
        expect(thinking).toContain('Secret plan');
    });

    it('returns empty text when the content is only thinking', () => {
        const { text, thinking } = stripInlineThinking('<think>\nOnly reasoning, no answer.\n</think>');
        expect(text).toBe('');
        expect(thinking).toContain('Only reasoning');
    });

    it('strips an orphan closing tag with the reply after it (opening tag went to the reasoning stream)', () => {
        const { text, thinking } = stripInlineThinking('</think>\n\n*adjusts med-kit* I am Juno, crisis medic.');
        expect(text).toBe('*adjusts med-kit* I am Juno, crisis medic.');
        expect(thinking).toBe('');
    });

    it('reclassifies reasoning that precedes an orphan closing tag', () => {
        const { text, thinking } = stripInlineThinking('my secret is that I am the traitor, so I should deflect</think>{"reply":"Nothing suspicious here."}');
        expect(text).toBe('{"reply":"Nothing suspicious here."}');
        expect(thinking).toContain('traitor');
        expect(text).not.toContain('traitor');
    });

    it('merges multiple think blocks', () => {
        const { text, thinking } = stripInlineThinking('<think>one</think>{"reply":"Hi."}<think>two</think>');
        expect(text).toBe('{"reply":"Hi."}');
        expect(thinking).toContain('one');
        expect(thinking).toContain('two');
    });
});

describe('mergeThinking', () => {
    it('joins present parts and drops empties', () => {
        expect(mergeThinking('a', '', 'b', undefined, null)).toBe('a\nb');
        expect(mergeThinking('', undefined)).toBe('');
    });
});
