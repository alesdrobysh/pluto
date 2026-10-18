import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  new URL('../../electron/main.ts', import.meta.url),
  'utf8',
);
const start = source.indexOf('  const runSecondaryRecovery = async () => {');
const end = source.indexOf('  const scheduleSecondaryRecovery =', start);
if (start < 0 || end < start)
  throw new Error('Missing secondary recovery block');
const createRecovery = new Function(
  'db',
  'meetingNotesRunCoordinator',
  'randomUUID',
  `let secondaryRecoveryRunning = false;
   const secondaryAttempts = new Map();
   const activeTranscriptionCount = 0;
   ${source.slice(start, end)}
   return runSecondaryRecovery;`,
);

afterEach(() => vi.useRealTimers());

describe('startup secondary recovery provider boundary', () => {
  it.each(['ollama', 'chatgpt'])(
    'keeps %s recovery within its usage policy',
    async (provider) => {
      vi.useFakeTimers();
      const generate = vi.fn().mockResolvedValue(undefined);
      const recover = createRecovery(
        {
          listMeetingIdsWithFailedSecondary: () => ['first', 'second'],
          getSetting: () => provider,
        },
        { generateAndPublishMeetingNotes: generate },
        () => 'request',
      );
      const pending = recover();
      await vi.runAllTimersAsync();
      await pending;
      expect(generate).toHaveBeenCalledTimes(provider === 'ollama' ? 2 : 0);
    },
  );

  it('stops recovery when the user switches to ChatGPT between meetings', async () => {
    vi.useFakeTimers();
    let provider = 'ollama';
    const generate = vi.fn(async () => {
      provider = 'chatgpt';
    });
    const recover = createRecovery(
      {
        listMeetingIdsWithFailedSecondary: () => ['first', 'second'],
        getSetting: () => provider,
      },
      { generateAndPublishMeetingNotes: generate },
      () => 'request',
    );
    const pending = recover();
    await vi.runAllTimersAsync();
    await pending;
    expect(generate).toHaveBeenCalledOnce();
  });
});
