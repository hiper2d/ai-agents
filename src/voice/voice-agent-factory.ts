import type { ApiKeyMap } from '../types';
import type { VoiceAgent, VoiceProvider } from './types';
import { SUPPORTED_VOICE_PROVIDERS, VOICE_PROVIDER_API_KEY } from './voice-catalog';
import { OpenAiVoiceAgent } from './openai-voice-agent';
import { GoogleVoiceAgent } from './google-voice-agent';

/** The voice counterpart of AgentFactory: provider in, agent out. */
export class VoiceAgentFactory {
    /** Build an agent from a key already resolved by the caller. */
    static createAgent(provider: VoiceProvider, apiKey: string): VoiceAgent {
        switch (provider) {
            case 'openai':
                return new OpenAiVoiceAgent(apiKey);
            case 'google':
                return new GoogleVoiceAgent(apiKey);
            default:
                throw new Error(`Unknown voice provider: ${provider}`);
        }
    }

    /**
     * Build an agent from a key map (the shape AgentFactory takes), reading the
     * provider's key by its API_KEY_CONSTANTS name. Throws when the key is missing
     * so the host can report a misconfiguration before any SDK is touched.
     */
    static createAgentFromKeys(provider: VoiceProvider, apiKeys: ApiKeyMap): VoiceAgent {
        if (!SUPPORTED_VOICE_PROVIDERS.includes(provider)) {
            throw new Error(`Unknown voice provider: ${provider}`);
        }
        const keyName = VOICE_PROVIDER_API_KEY[provider];
        const apiKey = apiKeys[keyName];
        if (!apiKey) {
            throw new Error(`Missing API key ${keyName} for voice provider ${provider}`);
        }
        return VoiceAgentFactory.createAgent(provider, apiKey);
    }
}

/** Function form of `VoiceAgentFactory.createAgent`. */
export function createVoiceAgent(provider: VoiceProvider, apiKey: string): VoiceAgent {
    return VoiceAgentFactory.createAgent(provider, apiKey);
}
