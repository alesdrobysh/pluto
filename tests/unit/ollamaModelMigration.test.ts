import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabaseStorageSetup } from '../../electron/database/storageSetup';
import {
  OLLAMA_MODEL_MIGRATION_SETTING,
  migrateOllamaModelDatabase,
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

describe('migration inside database startup recovery', () => {
  function databaseFixture() {
    const f = fixture({ setup_complete: 'true' });
    const connection = {
      prepare: vi.fn((sql: string) => {
        if (sql === 'SELECT value FROM settings WHERE key = ?') {
          return {
            get: (key: string) => {
              const value = f.store.getSetting(key);
              return value === undefined ? undefined : { value };
            },
          };
        }
        if (
          sql === 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
        ) {
          return { run: f.store.setSetting };
        }
        throw new Error('Unexpected settings query');
      }),
      transaction: (run: () => void) => () => f.store.transaction(run),
    } as unknown as Parameters<typeof migrateOllamaModelDatabase>[0];
    return { ...f, connection };
  }

  it('rolls back a failed marker write, enters recovery without main, and retries once', () => {
    defaults.model = 'future-mtp:12b';
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pluto-migration-startup-'),
    );
    const databasePath = path.join(dir, 'pluto.db');
    fs.writeFileSync(databasePath, 'SQLite format 3\0');
    const f = databaseFixture();
    const main = vi.fn();
    const recovery = vi.fn();
    const save = f.store.setSetting.getMockImplementation()!;
    let failMarker = true;
    f.store.setSetting.mockImplementation((key, value) => {
      if (key === OLLAMA_MODEL_MIGRATION_SETTING && failMarker) {
        failMarker = false;
        throw new Error('disk full');
      }
      save(key, value);
    });
    const start = () => {
      try {
        initializeDatabaseStorageSetup({
          databasePath,
          chooseMode: () => {
            throw new Error('Existing profile must retain storage');
          },
          prepareEncryption: () => {
            throw new Error('Standard profile must not request keys');
          },
          initialize: () => migrateOllamaModelDatabase(f.connection),
        });
        main();
      } catch (error) {
        recovery(error);
      }
    };
    try {
      start();
      expect(recovery).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'disk full' }),
      );
      expect(main).not.toHaveBeenCalled();
      expect(f.values).toEqual({ setup_complete: 'true' });
      expect(fs.existsSync(path.join(dir, 'database-storage.json'))).toBe(
        false,
      );
      start();
      expect(main).toHaveBeenCalledOnce();
      expect(recovery).toHaveBeenCalledOnce();
      expect(f.values).toEqual({
        setup_complete: 'true',
        ollama_model: 'gemma4:12b',
        [OLLAMA_MODEL_MIGRATION_SETTING]: '1',
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(dir, 'database-storage.json'), 'utf8'),
        ),
      ).toEqual({ version: 1, mode: 'standard', initialized: true });
      f.store.setSetting.mockClear();
      migrateOllamaModelDatabase(f.connection);
      expect(f.store.setSetting).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['database is locked', 'encrypted database key unavailable'])(
    'propagates initialization failure before migration: %s',
    (message) => {
      defaults.model = 'future-mtp:12b';
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'pluto-migration-init-'),
      );
      const databasePath = path.join(dir, 'pluto.db');
      fs.writeFileSync(databasePath, 'SQLite format 3\0');
      const f = databaseFixture();
      const initializeConnection = vi.fn(() => {
        throw new Error(message);
      });
      try {
        expect(() =>
          initializeDatabaseStorageSetup({
            databasePath,
            chooseMode: () => 'standard',
            prepareEncryption: vi.fn(),
            initialize: () => {
              initializeConnection();
              migrateOllamaModelDatabase(f.connection);
            },
          }),
        ).toThrow(message);
        expect(f.connection.prepare).not.toHaveBeenCalled();
        expect(f.values).toEqual({ setup_complete: 'true' });
        expect(fs.existsSync(path.join(dir, 'database-storage.json'))).toBe(
          false,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('does not touch the database adapter before a default transition', () => {
    defaults.model = 'gemma4:12b';
    const f = databaseFixture();
    migrateOllamaModelDatabase(f.connection);
    expect(f.connection.prepare).not.toHaveBeenCalled();
    expect(f.store.transaction).not.toHaveBeenCalled();
  });

  it('keeps malformed existing storage in recovery before migration or main starts', () => {
    defaults.model = 'future-mtp:12b';
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pluto-migration-invalid-'),
    );
    const databasePath = path.join(dir, 'pluto.db');
    fs.writeFileSync(databasePath, 'broken');
    const f = databaseFixture();
    const initialize = vi.fn(() => migrateOllamaModelDatabase(f.connection));
    try {
      expect(() =>
        initializeDatabaseStorageSetup({
          databasePath,
          chooseMode: () => 'standard',
          prepareEncryption: vi.fn(),
          initialize,
        }),
      ).toThrow('incomplete');
      expect(initialize).not.toHaveBeenCalled();
      expect(f.connection.prepare).not.toHaveBeenCalled();
      expect(fs.readFileSync(databasePath, 'utf8')).toBe('broken');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
