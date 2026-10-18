import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DEFAULT_MODELS,
  resolveConfiguredProviderModel,
} from '../../electron/llm/providerCatalog';
import { OLLAMA_GENERAL_MODEL } from '../../src/utils/ollamaModels';

describe('configured provider model diagnostics', () => {
  it.each([
    [{}, false, OLLAMA_GENERAL_MODEL],
    [{ llm_model: 'legacy:latest' }, false, 'legacy:latest'],
    [
      {
        llm_provider: 'ollama',
        llm_model: 'legacy:latest',
        ollama_model: ' custom:latest ',
      },
      false,
      'custom:latest',
    ],
    [
      {
        llm_provider: 'ollama',
        ollama_model: 'general:latest',
        ollama_fast_model: 'quick:latest',
      },
      false,
      'general:latest',
    ],
    [
      {
        llm_provider: 'ollama',
        ollama_model: 'general:latest',
        ollama_fast_model: 'quick:latest',
      },
      true,
      'quick:latest',
    ],
    [
      {
        llm_provider: 'chatgpt',
        llm_model: 'legacy:latest',
        chatgpt_model: ' account-terra ',
      },
      false,
      'account-terra',
    ],
    [
      {
        llm_provider: 'chatgpt',
        llm_model: 'legacy:latest',
        chatgpt_model: 'account-terra',
        ollama_fast_model: 'quick:latest',
      },
      true,
      'account-terra',
    ],
    [{ llm_provider: 'chatgpt', llm_model: 'legacy:latest' }, false, ''],
    [{ llm_provider: 'chatgpt', chatgpt_model: ' ' }, false, ''],
    [
      {
        llm_provider: 'openai',
        llm_model: 'legacy:latest',
        openai_model: 'cloud-selected',
      },
      false,
      'cloud-selected',
    ],
    [
      {
        llm_provider: 'openrouter',
        llm_model: 'legacy:latest',
        openrouter_model: 'vendor/selected',
      },
      false,
      'vendor/selected',
    ],
    [
      {
        llm_provider: 'claude',
        llm_model: 'legacy:latest',
        claude_model: 'claude-selected',
      },
      false,
      'claude-selected',
    ],
    [
      {
        llm_provider: 'gemini',
        llm_model: 'legacy:latest',
        gemini_model: ' selected ',
      },
      false,
      'selected',
    ],
    [
      { llm_provider: 'gemini', gemini_model: 'gemini-1.5-flash' },
      false,
      PROVIDER_DEFAULT_MODELS.gemini,
    ],
    [
      { llm_provider: 'gemini', gemini_model: 'gemini-2.0-flash' },
      false,
      PROVIDER_DEFAULT_MODELS.gemini,
    ],
    [
      { llm_provider: 'gemini', gemini_model: ' ' },
      false,
      PROVIDER_DEFAULT_MODELS.gemini,
    ],
    [
      { llm_provider: 'openai', openai_model: '', llm_model: 'legacy:latest' },
      false,
      PROVIDER_DEFAULT_MODELS.openai,
    ],
    [
      { llm_provider: 'openrouter', llm_model: 'legacy:latest' },
      false,
      PROVIDER_DEFAULT_MODELS.openrouter,
    ],
    [
      { llm_provider: 'claude', llm_model: 'legacy:latest' },
      false,
      PROVIDER_DEFAULT_MODELS.claude,
    ],
  ] as const)(
    'matches the selected provider without stale legacy labels: %j (quick=%s)',
    (settings, quick, expected) => {
      expect(resolveConfiguredProviderModel(settings, quick)).toBe(expected);
    },
  );
});
