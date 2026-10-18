export const OLLAMA_GENERAL_MODEL = 'gemma4:12b';
export const OLLAMA_QUICK_CHAT_MODEL = OLLAMA_GENERAL_MODEL;
export const OLLAMA_GEMMA_MTP_MODEL = 'gemma4:12b-mlx';

export const usesGemmaMtpDefaults = (model: string): boolean => {
  const name = model.trim().toLowerCase();
  return [
    OLLAMA_GEMMA_MTP_MODEL,
    `library/${OLLAMA_GEMMA_MTP_MODEL}`,
    `registry.ollama.ai/library/${OLLAMA_GEMMA_MTP_MODEL}`,
  ].includes(name);
};

export const resolveConfiguredOllamaModel = (
  settings: {
    ollama_model?: string;
    ollama_fast_model?: string;
    llm_model?: string;
  },
  quick = false,
): string =>
  (quick ? settings.ollama_fast_model?.trim() : '') ||
  settings.ollama_model?.trim() ||
  settings.llm_model?.trim() ||
  OLLAMA_GENERAL_MODEL;
