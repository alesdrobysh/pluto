import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommitmentReminderNotifications } from '../../electron/commitmentReminderNotifications';

vi.mock('electron', () => ({ app: {} }));
const candidate = {
  id: 'fictional-action',
  obligationId: 'fictional-action',
  name: 'Send estimate',
  status: 'active',
  due_date: '2026-10-10',
  metadata: '{"commitment_state":"confirmed"}',
};
const reminder = {
  entityId: candidate.id,
  obligationId: candidate.id,
  deadlineRevision: 'date:2026-10-10',
  scheduledAt: 0,
  expiresAt: Number.POSITIVE_INFINITY,
  attempts: 0,
};
function fixture(status = 'authorized') {
  const settings = new Map<string, string>();
  const bridge = {
    status: vi.fn(async () => status),
    request: vi.fn(async () => 'authorized'),
    submit: vi.fn(async () => 'submitted'),
    cancel: vi.fn(),
    onClick: vi.fn(),
  };
  const onClick = vi.fn();
  const adapter = createCommitmentReminderNotifications({
    bridge,
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => {
      settings.set(key, value);
    },
    onClick,
    now: () => Date.parse('2026-10-10T18:00:00Z'),
    timeZone: () => 'America/Los_Angeles',
  });
  return { adapter, settings, bridge, onClick };
}
afterEach(() => vi.useRealTimers());
describe('native commitment notification adapter', () => {
  it('requests permission once in context and never repeats denial', async () => {
    const f = fixture('not-determined');
    f.bridge.request.mockResolvedValue('denied');
    expect(await f.adapter.available()).toBe(false);
    expect(f.settings.get('commitmentReminderPermissionRequested')).toBe(
      'true',
    );
    expect(await f.adapter.available()).toBe(false);
    expect(f.bridge.request).toHaveBeenCalledTimes(1);
    f.bridge.status.mockResolvedValue('authorized');
    expect(await f.adapter.available()).toBe(true);
  });
  it('does not prompt for denied, unsupported or disabled notifications', async () => {
    for (const status of ['denied', 'unsupported', 'error']) {
      const f = fixture(status);
      expect(await f.adapter.available()).toBe(false);
      expect(f.bridge.request).not.toHaveBeenCalled();
    }
    const f = fixture('not-determined');
    f.settings.set('automaticCommitmentReminders', 'false');
    expect(await f.adapter.available()).toBe(false);
    expect(await f.adapter.submit(candidate, reminder)).toBe('blocked');
    expect(f.bridge.status).not.toHaveBeenCalled();
    expect(f.bridge.submit).not.toHaveBeenCalled();
  });
  it('defaults to detailed copy and reads preview preference at dispatch', async () => {
    const f = fixture();
    expect(await f.adapter.submit(candidate, reminder)).toBe('submitted');
    expect(f.bridge.submit.mock.calls[0]).toEqual([
      expect.stringMatching(/^pluto-commitment-[a-f0-9]{64}$/),
      'Pluto',
      'Send estimate is due today',
      candidate.id,
    ]);
    f.settings.set('commitmentReminderPreviews', 'true');
    await f.adapter.submit(
      { ...candidate, verifiedOtherOwnerName: 'Alex' },
      reminder,
    );
    expect(f.bridge.submit.mock.calls[1][2]).toBe(
      'Follow up with Alex: Send estimate is due today',
    );
    f.settings.set('commitmentReminderPreviews', 'false');
    await f.adapter.submit(
      { ...candidate, verifiedOtherOwnerName: 'Alex' },
      reminder,
    );
    expect(f.bridge.submit.mock.calls[2][2]).toBe('A commitment is due today');
    expect(f.bridge.submit.mock.calls[0][0]).toBe(
      f.bridge.submit.mock.calls[1][0],
    );
    f.adapter.cancel?.(candidate.id);
    expect(f.bridge.cancel).toHaveBeenCalledWith(
      f.bridge.submit.mock.calls[0][0],
    );
  });
  it('only marks an explicit OS rejection failed; unknown/throw/timeout stay ambiguous', async () => {
    const f = fixture();
    f.bridge.submit.mockResolvedValue('failed');
    expect(await f.adapter.submit(candidate, reminder)).toBe('failed');
    f.bridge.submit.mockRejectedValue(new Error('disconnected'));
    expect(await f.adapter.submit(candidate, reminder)).toBe('ambiguous');
    vi.useFakeTimers();
    f.bridge.submit.mockImplementation(() => new Promise(() => {}));
    const pending = f.adapter.submit(candidate, reminder);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe('ambiguous');
  });
  it('routes a persisted identifier without leaking notification body into navigation', () => {
    const f = fixture();
    const click = f.bridge.onClick.mock.calls[0][0] as (id: string) => void;
    click(candidate.id);
    click('');
    expect(f.onClick).toHaveBeenCalledExactlyOnceWith(candidate.id);
  });
});
