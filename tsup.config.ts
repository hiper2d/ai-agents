import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    // Every provider SDK and zod stay external: consumers install them (zod is a peer on
    // purpose — ZodSchemaConverter reads `_def`, and two zod copies would break that).
    external: ['@anthropic-ai/sdk', '@google/genai', '@mistralai/mistralai', 'openai', 'zod', 'zod-to-json-schema'],
});
