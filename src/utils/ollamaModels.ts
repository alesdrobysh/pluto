export const OLLAMA_GENERAL_MODEL = 'gemma4:12b';
export const OLLAMA_QUICK_CHAT_MODEL = 'phi4-mini:3.8b';

export const resolveConfiguredOllamaModel = (
  settings: {
    ollama_model?: string;
    ollama_fast_model?: string;
    llm_model?: string;
  },
  quick = false,
): string =>
  quick
    ? settings.ollama_fast_model?.trim() || OLLAMA_QUICK_CHAT_MODEL
    : settings.ollama_model?.trim() ||
      settings.llm_model?.trim() ||
      OLLAMA_GENERAL_MODEL;
