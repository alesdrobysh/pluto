import { describe, expect, it } from 'vitest';
import {
  ChromeTabClosureTracker,
  meetKey,
  parseChromeTabs,
} from '../../electron/activeCall/chromeTabClosure';

const callKey = meetKey('https://meet.google.com/abc-defg-hij')!;
const snapshot = (
  tabs: { id: string; meetingKey: string | null }[],
  healthy = true,
) => ({ healthy, tabs });

describe('exact Chrome Meet tab closure', () => {
  it('parses tab identities without retaining raw URLs or accepting malformed output', () => {
    const parsed = parseChromeTabs(
      'window-1\ttab-1\thttps://meet.google.com/abc-defg-hij?authuser=1\n' +
        'window-1\ttab-2\thttps://example.com/private\n',
    );
    expect(parsed).toEqual(
      snapshot([
        { id: 'tab-1', meetingKey: callKey },
        { id: 'tab-2', meetingKey: null },
      ]),
    );
    expect(JSON.stringify(parsed)).not.toContain('authuser');
    expect(parseChromeTabs('window-1\ttab-1\n').healthy).toBe(false);
    expect(
      parseChromeTabs(
        'window-1\ttab-1\thttps://meet.google.com/abc-defg-hij\n' +
          'window-2\ttab-1\thttps://example.com\n',
      ).healthy,
    ).toBe(false);
  });

  it('requires a unique Meet tab twice before binding and two successful absent observations before closure', () => {
    const tracker = new ChromeTabClosureTracker();
    const open = snapshot([{ id: 'tab-1', meetingKey: callKey }]);
    expect(tracker.observe(open, 'chrome-instance', 0)).toBe('unknown');
    expect(tracker.observe(open, 'chrome-instance', 1_000)).toBe('unknown');
    expect(tracker.observe(open, 'chrome-instance', 2_000, true)).toBe('unknown');
    expect(tracker.observe(open, 'chrome-instance', 2_999, true)).toBe('unknown');
    expect(tracker.observe(open, 'chrome-instance', 3_000, true)).toBe('bound');
    expect(tracker.tracking).toBe(true);
    expect(tracker.observe(open, 'chrome-instance', 4_000)).toBe('unknown');
    expect(tracker.observe(snapshot([]), 'chrome-instance', 5_000)).toBe(
      'unknown',
    );
    expect(tracker.observe(snapshot([]), 'chrome-instance', 5_999)).toBe(
      'unknown',
    );
    expect(tracker.observe(snapshot([]), 'chrome-instance', 6_000)).toBe(
      'closed',
    );
  });

  it('keeps recording on inspection failures, navigation, tab replacement, and multiple calls', () => {
    const tracker = new ChromeTabClosureTracker();
    const open = snapshot([{ id: 'tab-1', meetingKey: callKey }]);
    tracker.observe(open, 'chrome-instance', 0, true);
    tracker.observe(open, 'chrome-instance', 1_000, true);
    tracker.observe(snapshot([]), 'chrome-instance', 2_000);
    tracker.observe(snapshot([], false), 'chrome-instance', 3_000);
    expect(tracker.observe(open, 'chrome-instance', 4_000)).toBe('unknown');
    expect(tracker.observe(snapshot([]), 'chrome-instance', 5_000)).toBe(
      'unknown',
    );
    tracker.observe(
      snapshot([{ id: 'tab-2', meetingKey: callKey }]),
      'chrome-instance',
      6_000,
    );
    expect(tracker.tracking).toBe(false);
    expect(tracker.observe(snapshot([]), 'chrome-instance', 8_000)).toBe(
      'unknown',
    );

    const another = new ChromeTabClosureTracker();
    another.observe(open, 'chrome-instance', 0, true);
    another.observe(open, 'chrome-instance', 1_000, true);
    another.observe(
      snapshot([{ id: 'tab-1', meetingKey: null }]),
      'chrome-instance',
      2_000,
    );
    expect(another.tracking).toBe(false);
    expect(another.observe(snapshot([]), 'chrome-instance', 4_000)).toBe(
      'unknown',
    );

    const multiple = new ChromeTabClosureTracker();
    multiple.observe(
      snapshot([
        { id: 'tab-1', meetingKey: callKey },
        { id: 'tab-2', meetingKey: callKey },
      ]),
      'chrome-instance',
      0,
    );
    expect(multiple.tracking).toBe(false);

    const replaced = new ChromeTabClosureTracker();
    replaced.observe(open, 'chrome-instance', 0, true);
    replaced.observe(open, 'chrome-instance', 1_000, true);
    expect(replaced.observe(snapshot([]), 'chrome-instance', 2_000)).toBe('unknown');
    expect(
      replaced.observe(
        snapshot([{ id: 'next-tab', meetingKey: 'another-meeting' }]),
        'chrome-instance',
        3_000,
      ),
    ).toBe('unknown');
    expect(replaced.tracking).toBe(false);
    expect(replaced.observe(snapshot([]), 'chrome-instance', 5_000)).toBe('unknown');
  });
});
