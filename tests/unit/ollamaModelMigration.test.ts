import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OLLAMA_MODEL_MIGRATION_SETTING,
  migrateOllamaModelSettings,
} from '../../electron/llm/ollamaModelMigration';

const defaults = vi.hoisted(() => ({ model: 'future-mtp:12b' }));
vi.mock('../../src/utils/ollamaModels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/ollamaModels')>()),
  get OLLAMA_GENERAL_MODEL() {
    return defaults.model;
  },
}));

function fixture(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const store = {
    getSetting: vi.fn((key: string) => values[key]),
    setSetting: vi.fn((key: string, value: string) => {
      values[key] = value;
    }),
    transaction: vi.fn((run: () => void) => {
      const before = { ...values };
      try {
        run();
      } catch (error) {
        for (const key of Object.keys(values)) delete values[key];
        Object.assign(values, before);
        throw error;
      }
    }),
  };
  return { values, store };
}

describe('one-time Ollama default migration', () => {
  beforeEach(() => {
    defaults.model = 'future-mtp:12b';
  });

  it('does not claim a transition while the historical default is still active', () => {
    defaults.model = 'gemma4:12b';
    const f = fixture({ setup_complete: 'true' });
    migrateOllamaModelSettings(f.store);
    expect(f.values).toEqual({ setup_complete: 'true' });
    expect(f.store.transaction).not.toHaveBeenCalled();
    expect(f.store.setSetting).not.toHaveBeenCalled();
    defaults.model = 'future-mtp:12b';
    migrateOllamaModelSettings(f.store);
    expect(f.values.ollama_model).toBe('gemma4:12b');
    expect(f.values[OLLAMA_MODEL_MIGRATION_SETTING]).toBe('1');
  });
  it.each([undefined, 'ollama', 'unrecognized-provider'])(
    'preserves the old implicit default for completed local profiles (%s)',
    (provider) => {
      const f = fixture({
        setup_complete: 'true',
        llm_provider: provider,
        ollama_fast_model: 'custom-quick:latest',
      });
      migrateOllamaModelSettings(f.store);
      expect(f.values).toEqual({
        setup_complete: 'true',
        llm_provider: provider,
        ollama_fast_model: 'custom-quick:latest',
        ollama_model: 'gemma4:12b',
        [OLLAMA_MODEL_MIGRATION_SETTING]: '1',
      });
      expect(f.store.transaction).toHaveBeenCalledOnce();
    },
  );

  it('treats blank overrides like the model resolver and keeps the quick override', () => {
    const f = fixture({
      setup_complete: 'true',
      ollama_model: ' ',
      llm_model: '\t',
      ollama_fast_model: 'quick:tiny',
    });
    migrateOllamaModelSettings(f.store);
    expect(f.values.ollama_model).toBe('gemma4:12b');
    expect(f.values.llm_model).toBe('\t');
    expect(f.values.ollama_fast_model).toBe('quick:tiny');
  });

  it.each([
    { ollama_model: 'my-custom:latest' },
    { llm_model: 'legacy:latest' },
    { ollama_model: ' ', llm_model: ' legacy:latest ' },
    { ollama_model: 'gemma4:12b', ollama_fast_model: 'my-quick:latest' },
  ])('preserves explicit general and legacy selections: %j', (settings) => {
    const f = fixture({
      setup_complete: 'true',
      llm_provider: 'ollama',
      ...settings,
    });
    const before = { ...f.values };
    migrateOllamaModelSettings(f.store);
    expect(f.values).toEqual({
      ...before,
      [OLLAMA_MODEL_MIGRATION_SETTING]: '1',
    });
    expect(f.store.setSetting).toHaveBeenCalledOnce();
  });

  it.each(['chatgpt', 'openai', 'openrouter', 'gemini', 'claude'])(
    'leaves existing %s selection untouched',
    (provider) => {
      const f = fixture({
        setup_complete: 'true',
        llm_provider: provider,
        [`${provider}_model`]: 'selected-model',
      });
      const before = { ...f.values };
      migrateOllamaModelSettings(f.store);
      expect(f.values).toEqual({
        ...before,
        [OLLAMA_MODEL_MIGRATION_SETTING]: '1',
      });
    },
  );

  it.each([undefined, 'false'])(
    'does not pin a new or unfinished profile (%s)',
    (setup) => {
      const f = fixture({ setup_complete: setup });
      migrateOllamaModelSettings(f.store);
      expect(f.values.ollama_model).toBeUndefined();
      f.values.setup_complete = 'true';
      migrateOllamaModelSettings(f.store);
      expect(f.values.ollama_model).toBeUndefined();
    },
  );

  it('does not repin after a migrated user clears the override', () => {
    const f = fixture({ setup_complete: 'true' });
    migrateOllamaModelSettings(f.store);
    f.values.ollama_model = '';
    f.store.setSetting.mockClear();
    migrateOllamaModelSettings(f.store);
    expect(f.values.ollama_model).toBe('');
    expect(f.store.setSetting).not.toHaveBeenCalled();
  });

  it('does not misclassify a cloud profile that later switches to local', () => {
    const f = fixture({ setup_complete: 'true', llm_provider: 'chatgpt' });
    migrateOllamaModelSettings(f.store);
    f.values.llm_provider = 'ollama';
    migrateOllamaModelSettings(f.store);
    expect(f.values.ollama_model).toBeUndefined();
  });

  it('keeps the model and marker atomic when a write fails, then can retry', () => {
    const f = fixture({ setup_complete: 'true' });
    const save = f.store.setSetting.getMockImplementation()!;
    f.store.setSetting.mockImplementation((key, value) => {
      if (key === OLLAMA_MODEL_MIGRATION_SETTING) throw new Error('disk full');
      save(key, value);
    });
    expect(() => migrateOllamaModelSettings(f.store)).toThrow('disk full');
    expect(f.values).toEqual({ setup_complete: 'true' });
    f.store.setSetting.mockImplementation(save);
    migrateOllamaModelSettings(f.store);
    expect(f.values).toEqual({
      setup_complete: 'true',
      ollama_model: 'gemma4:12b',
      [OLLAMA_MODEL_MIGRATION_SETTING]: '1',
    });
  });
});
