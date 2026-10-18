import { OLLAMA_GENERAL_MODEL } from '../../src/utils/ollamaModels';
import type {
  ApiKeyProviderId,
  CloudProviderId,
  ProviderId,
} from './inferenceTypes';

export const CLOUD_CONSENT_VERSION = '1';

export const PROVIDER_DEFAULT_MODELS: Record<ProviderId, string> = {
  ollama: OLLAMA_GENERAL_MODEL,
  chatgpt: '', // The signed-in account supplies its model catalog.
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  gemini: 'gemini-3.8-flash',
  claude: 'claude-3-haiku-20240307',
};

export const OPENROUTER_CURATED_MODELS = [
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-haiku',
  'google/gemini-2.5-flash',
] as const;

export const isCloudProvider = (
  provider: ProviderId,
): provider is CloudProviderId => provider !== 'ollama';

export const credentialSettingKey = (provider: ApiKeyProviderId) =>
  `${provider}_api_key` as const;

export const cloudConsentSettingKey = (provider: CloudProviderId) =>
  `cloud_consent_${provider}` as const;
