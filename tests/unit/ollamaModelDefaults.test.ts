import { describe, expect, it } from 'vitest';
import { NOTES_OLLAMA_MODEL } from '../../electron/llm/meetingNotesTypes';
import {
  OLLAMA_GENERAL_MODEL,
  OLLAMA_QUICK_CHAT_MODEL,
  resolveConfiguredOllamaModel,
} from '../../src/utils/ollamaModels';

describe('Ollama model defaults', () => {
  it('uses one Gemma model for analysis and quick chat by default', () => {
    expect(OLLAMA_GENERAL_MODEL).toBe('gemma4:12b');
    expect(NOTES_OLLAMA_MODEL).toBe(OLLAMA_GENERAL_MODEL);
    expect(OLLAMA_QUICK_CHAT_MODEL).toBe(OLLAMA_GENERAL_MODEL);
  });
  it.each([
    [{}, false, OLLAMA_GENERAL_MODEL],
    [{}, true, OLLAMA_GENERAL_MODEL],
    [{ ollama_model: ' custom:latest ' }, true, 'custom:latest'],
    [
      { ollama_model: 'custom:latest', ollama_fast_model: 'fast:latest' },
      true,
      'fast:latest',
    ],
    [
      { ollama_model: 'custom:latest', ollama_fast_model: 'fast:latest' },
      false,
      'custom:latest',
    ],
    [{ ollama_model: ' ', llm_model: 'legacy:latest' }, false, 'legacy:latest'],
  ] as const)(
    'resolves configured models without requiring a second default',
    (settings, quick, expected) => {
      expect(resolveConfiguredOllamaModel(settings, quick)).toBe(expected);
    },
  );
});
