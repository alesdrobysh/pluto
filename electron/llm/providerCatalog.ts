import {
  OLLAMA_GENERAL_MODEL,
  resolveConfiguredOllamaModel,
} from '../../src/utils/ollamaModels';
import type {
  ApiKeyProviderId,
  CloudProviderId,
  ProviderId,
} from './inferenceTypes';
import type { LLMSettings } from './provider';

export const getProviderDisplayName = (provider: unknown): string => {
  switch (provider) {
    case 'ollama':
      return 'Ollama (Local)';
    case 'gemini':
      return 'Google Gemini';
    case 'chatgpt':
      return 'ChatGPT';
    case 'openai':
      return 'OpenAI';
    case 'openrouter':
      return 'OpenRouter';
    case 'claude':
      return 'Anthropic Claude';
    default:
      return 'LLM';
  }
};

export const CLOUD_CONSENT_VERSION = '1';

export const PROVIDER_DEFAULT_MODELS: Record<ProviderId, string> = {
  ollama: OLLAMA_GENERAL_MODEL,
  chatgpt: '', // The signed-in account supplies its model catalog.
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  gemini: 'gemini-3.8-flash',
  claude: 'claude-3-haiku-20240307',
};

export const resolveGeminiModelName = (configured?: string): string => {
  const model = (configured || '').trim();
  return !model || model === 'gemini-1.5-flash' || model === 'gemini-2.0-flash'
    ? 'gemini-3.8-flash'
    : model;
};

export const resolveConfiguredProviderModel = (
  settings: LLMSettings,
  quick = false,
): string => {
  const provider = settings.llm_provider ?? 'ollama';
  if (provider === 'ollama')
    return resolveConfiguredOllamaModel(settings, quick);
  if (provider === 'gemini')
    return resolveGeminiModelName(settings.gemini_model);
  if (provider === 'chatgpt') return settings.chatgpt_model?.trim() || '';
  return settings[`${provider}_model`] || PROVIDER_DEFAULT_MODELS[provider];
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
