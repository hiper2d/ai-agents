import { z } from 'zod';
import { ZodSchemaConverter } from './zod-schema-converter';

/**
 * Pins the JSON Schema shape sent to Anthropic structured outputs: strict objects, standard
 * nullability (a "null" type entry, not OpenAPI `nullable`), `anyOf` for unions, and optional
 * keys left out of `required`. Built from the game's night-action schema shapes.
 */
describe('ZodSchemaConverter.toAnthropicSchema', () => {
    const Doctor = z.object({
        reasoning: z.string().describe('Reasoning for the choice'),
        target: z.string().describe('The exact name of the player to protect'),
        action_type: z.enum(['protect', 'kill']).nullable().optional().describe('The type of action'),
        narrativeHint: z.string().nullable().optional(),
    });

    it('emits a strict object with optional keys outside required', () => {
        const schema = ZodSchemaConverter.toAnthropicSchema(Doctor);
        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(['reasoning', 'target']);
        expect(schema.properties.target).toEqual({ type: 'string', description: 'The exact name of the player to protect' });
    });

    it('turns nullable into an anyOf with a null variant, keeping enums and descriptions', () => {
        // Not a `["string", "null"]` type array: Anthropic refuses that next to an enum
        // ("Enum value 'protect' does not match declared type", live 2026-10-20).
        const schema = ZodSchemaConverter.toAnthropicSchema(Doctor);
        expect(schema.properties.action_type).toEqual({
            anyOf: [{ type: 'string', enum: ['protect', 'kill'] }, { type: 'null' }],
            description: 'The type of action',
        });
        expect(schema.properties.narrativeHint).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
        expect(JSON.stringify(schema)).not.toContain('nullable');
    });

    it('handles nested objects, arrays and unions', () => {
        const Nested = z.object({
            selected: z.array(z.string()),
            scene: z.object({ title: z.string(), mood: z.union([z.string(), z.number()]).nullable() }),
        });
        const schema = ZodSchemaConverter.toAnthropicSchema(Nested);
        expect(schema.properties.selected).toEqual({ type: 'array', items: { type: 'string' } });
        expect(schema.properties.scene.additionalProperties).toBe(false);
        expect(schema.properties.scene.properties.mood).toEqual({
            anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
        });
        expect(JSON.stringify(schema)).not.toContain('oneOf');
    });
});
