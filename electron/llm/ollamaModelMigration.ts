import { OLLAMA_GENERAL_MODEL } from '../../src/utils/ollamaModels';
import { PROVIDER_DEFAULT_MODELS } from './providerCatalog';

export const OLLAMA_MODEL_MIGRATION_SETTING =
  'ollama_default_model_migration_v1';
const historicalModel: string = 'gemma4:12b';

export function migrateOllamaModelSettings(store: {
  getSetting: (key: string) => unknown;
  setSetting: (key: string, value: string) => unknown;
  transaction: (run: () => void) => void;
}): void {
  if (OLLAMA_GENERAL_MODEL === historicalModel) return;
  store.transaction(() => {
    if (store.getSetting(OLLAMA_MODEL_MIGRATION_SETTING) === '1') return;
    const provider = store.getSetting('llm_provider');
    const usesCloud =
      typeof provider === 'string' &&
      provider !== 'ollama' &&
      Object.hasOwn(PROVIDER_DEFAULT_MODELS, provider);
    const isUnset = (value: unknown) =>
      typeof value !== 'string' || !value.trim();
    if (
      store.getSetting('setup_complete') === 'true' &&
      !usesCloud &&
      isUnset(store.getSetting('ollama_model')) &&
      isUnset(store.getSetting('llm_model'))
    ) {
      // Preserve the effective model from before the default changed; Settings can clear this override.
      store.setSetting('ollama_model', historicalModel);
    }
    // Mark new and cloud profiles too, so later setup or provider changes use the current default.
    store.setSetting(OLLAMA_MODEL_MIGRATION_SETTING, '1');
  });
}
