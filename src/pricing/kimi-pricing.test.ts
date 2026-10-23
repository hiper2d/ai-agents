import {
    extractTokenUsageFromResponse,
    calculateKimiCost
} from './kimi-pricing';
import { MODEL_PRICING } from '../catalog';

describe('Kimi Pricing Utils', () => {
    describe('extractTokenUsageFromResponse', () => {
        it('should extract token usage from OpenAI-compatible response', () => {
            const mockResponse = {
                usage: {
                    prompt_tokens: 150,
                    completion_tokens: 75,
                    total_tokens: 225
                }
            };

            const result = extractTokenUsageFromResponse(mockResponse);

            expect(result).toEqual({
                promptTokens: 150,
                completionTokens: 75,
                totalTokens: 225
            });
        });

        it('should handle missing optional fields gracefully', () => {
            const mockResponse = {
                usage: {}
            };

            const result = extractTokenUsageFromResponse(mockResponse);

            expect(result).toEqual({
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0
            });
        });

        it('should return null for invalid response', () => {
            expect(extractTokenUsageFromResponse(null)).toBeNull();
            expect(extractTokenUsageFromResponse({})).toBeNull();
            expect(extractTokenUsageFromResponse({ data: 'no usage' })).toBeNull();
        });

        it('should handle partial usage data', () => {
            const mockResponse = {
                usage: {
                    prompt_tokens: 100,
                    total_tokens: 150
                    // completion_tokens missing
                }
            };

            const result = extractTokenUsageFromResponse(mockResponse);

            expect(result).toEqual({
                promptTokens: 100,
                completionTokens: 0,
                totalTokens: 150
            });
        });
    });

    describe('calculateKimiCost', () => {
        it('should calculate cost for kimi-k3.1-pro model', () => {
            // kimi-k3.1-pro: $2.00/M input, $10.00/M output
            const cost = calculateKimiCost('kimi-k3.1-pro', 1000, 500);

            // 1K input tokens * $2.00/M + 0.5K output tokens * $10.00/M
            expect(cost).toBeCloseTo((1000 * 2.00 / 1000000) + (500 * 10.00 / 1000000), 5);
        });

        it('bills the highspeed tier at twice the Pro rate', () => {
            // kimi-k3.1-pro-highspeed: $4.00/M input, $20.00/M output, same $0.20 cache hit
            const cost = calculateKimiCost('kimi-k3.1-pro-highspeed', 1000, 500);
            expect(cost).toBeCloseTo(2 * calculateKimiCost('kimi-k3.1-pro', 1000, 500), 8);
        });

        it('should handle large token counts', () => {
            const cost = calculateKimiCost('kimi-k3.1-pro', 100000, 50000);

            // 100K input * $2.00/M + 50K output * $10.00/M
            expect(cost).toBeCloseTo((100000 * 2.00 / 1000000) + (50000 * 10.00 / 1000000), 5);
        });

        it('should handle unknown model gracefully', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            const cost = calculateKimiCost('unknown-model', 1000, 500);

            // Should return 0 for unknown model
            expect(cost).toBe(0);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No pricing information available'));

            consoleSpy.mockRestore();
        });

        it('should handle zero tokens', () => {
            const cost = calculateKimiCost('kimi-k3.1-pro', 0, 0);
            expect(cost).toBe(0);
        });

        it('should calculate fractional token costs correctly', () => {
            const cost = calculateKimiCost('kimi-k3.1-pro', 333, 777);

            // 333 input * $2.00/M + 777 output * $10.00/M
            const expectedCost = (333 * 2.00 / 1000000) + (777 * 10.00 / 1000000);
            expect(cost).toBeCloseTo(expectedCost, 5);
        });

        it('should calculate cost with cache hits (when supported)', () => {
            // Cache hits come from usage.prompt_tokens_details.cached_tokens; none passed here.
            const cost = calculateKimiCost('kimi-k3.1-pro', 1000000, 500000);

            // 1M input * $2.00/M + 0.5M output * $10.00/M (no cache)
            expect(cost).toBeCloseTo(2.0 + 5.0, 5);
        });
    });

    describe('MODEL_PRICING integration', () => {
        it('should have pricing for Kimi models', () => {
            expect(MODEL_PRICING['kimi-k3.1-pro']).toBeDefined();
            expect(MODEL_PRICING['kimi-k3.1-pro'].inputPrice).toBe(2.00);
            expect(MODEL_PRICING['kimi-k3.1-pro'].outputPrice).toBe(10.00);
            expect(MODEL_PRICING['kimi-k3.1-pro'].cacheHitPrice).toBe(0.20);
            expect(MODEL_PRICING['kimi-k3.1-pro-highspeed']).toEqual({ inputPrice: 4.00, outputPrice: 20.00, cacheHitPrice: 0.20 });
        });
    });
});
