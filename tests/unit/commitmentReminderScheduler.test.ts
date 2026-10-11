import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReminderCandidate } from '../../electron/commitmentReminderPolicy';
import {
  type PendingReminder,
  type ReminderPersistence,
  type ReminderSubmission,
  createCommitmentReminderScheduler,
} from '../../electron/commitmentReminderScheduler';
const NOW = Date.parse('2026-03-09T18:00:00Z');
const candidate: ReminderCandidate = {
  id: 'a',
  obligationId: 'a',
  name: 'Send estimate',
  status: 'active',
  due_date: '2026-03-09',
  metadata: '{"commitment_state":"confirmed"}',
};
function fixture() {
  let enabled = true;
  let ready = true;
  let current: ReminderCandidate | undefined = { ...candidate };
  const rows = new Map<string, PendingReminder & { state: string }>();
  const persistence: ReminderPersistence = {
    listCandidates: () => (current ? [current] : []),
    getCandidate: () => current,
    reconcile: (schedules) => {
      const keys = new Set(schedules.map((s) => s.deadlineRevision));
      for (const [key, row] of rows)
        if (!keys.has(key) && row.state === 'pending') row.state = 'canceled';
      for (const schedule of schedules) {
        const existing = rows.get(schedule.deadlineRevision);
        if (!existing || existing.state === 'canceled')
          rows.set(schedule.deadlineRevision, {
            ...schedule,
            attempts: 0,
            state: 'pending',
          });
      }
      return [...rows.values()].filter((r) => r.state === 'pending');
    },
    claim: (row) => {
      const stored = rows.get(row.deadlineRevision);
      if (stored?.state !== 'pending') return false;
      stored.state = 'attempted';
      stored.attempts++;
      return true;
    },
    finish: (row, outcome, _now, retryAt) => {
      const stored = rows.get(row.deadlineRevision)!;
      stored.state = retryAt ? 'pending' : outcome;
      stored.retryAt = retryAt;
    },
  };
  const adapter = {
    available: vi.fn(() => true),
    submit: vi.fn(async (): Promise<ReminderSubmission> => 'submitted'),
    cancel: vi.fn(),
  };
  const options = {
    persistence,
    adapter,
    enabled: () => enabled,
    ready: () => ready,
    timeZone: () => 'America/Los_Angeles',
    now: () => Date.now(),
  };
  return {
    options,
    rows,
    adapter,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    setCandidate: (value: ReminderCandidate | undefined) => {
      current = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('commitment reminder scheduler', () => {
  it('requests permission on first eligible work before the delivery slot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW - 3 * 86_400_000);
    const f = fixture();
    const scheduler = createCommitmentReminderScheduler(f.options);
    await scheduler.reconcile();
    scheduler.stop();
    expect(f.adapter.available).toHaveBeenCalledTimes(1);
    expect(f.adapter.submit).not.toHaveBeenCalled();
  });

  it('rechecks disablement after asynchronous candidate loading', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    f.options.persistence.listCandidates = async () => {
      await Promise.resolve();
      f.setEnabled(false);
      return [candidate];
    };
    const scheduler = createCommitmentReminderScheduler(f.options);
    await scheduler.reconcile();
    scheduler.stop();
    expect(f.rows.size).toBe(0);
    expect(f.adapter.available).not.toHaveBeenCalled();
    expect(f.adapter.submit).not.toHaveBeenCalled();
  });

  it('drains an in-flight submission and persists its result before stop allows DB close', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    let complete!: (value: ReminderSubmission) => void;
    f.adapter.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const scheduler = createCommitmentReminderScheduler(f.options);
    const sweep = scheduler.reconcile();
    await vi.waitFor(() => expect(f.adapter.submit).toHaveBeenCalledTimes(1));
    let closed = false;
    const shutdown = scheduler.stop().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.adapter.cancel).not.toHaveBeenCalled();
    expect([...f.rows.values()][0].state).toBe('attempted');
    complete('submitted');
    await shutdown;
    await sweep;
    expect(closed).toBe(true);
    expect([...f.rows.values()][0].state).toBe('submitted');
    expect(f.adapter.cancel).toHaveBeenCalledWith(candidate.id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates concurrent sweeps, restart and reopening same deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    const scheduler = createCommitmentReminderScheduler(f.options);
    await Promise.all([
      scheduler.reconcile(),
      scheduler.reconcile(),
      scheduler.reconcile(),
    ]);
    f.setCandidate({ ...candidate, status: 'completed' });
    await scheduler.reconcile();
    f.setCandidate(candidate);
    await scheduler.reconcile();
    scheduler.stop();
    const restarted = createCommitmentReminderScheduler(f.options);
    await restarted.reconcile();
    restarted.stop();
    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
  });
  it('revalidates completion, date removal and disablement after permission await', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const mutation of ['complete', 'remove', 'disable', 'locked']) {
      const f = fixture();
      f.adapter.available.mockImplementation(() => {
        if (mutation === 'complete')
          f.setCandidate({ ...candidate, status: 'completed' });
        if (mutation === 'remove')
          f.setCandidate({ ...candidate, due_date: null });
        if (mutation === 'disable') f.setEnabled(false);
        if (mutation === 'locked') f.setReady(false);
        return true;
      });
      const scheduler = createCommitmentReminderScheduler(f.options);
      await scheduler.reconcile();
      scheduler.stop();
      expect(f.adapter.submit).not.toHaveBeenCalled();
    }
  });
  it('suppresses ambiguous submission and crash-recovered attempted rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    f.adapter.submit.mockRejectedValue(new Error('unknown submission'));
    const scheduler = createCommitmentReminderScheduler(f.options);
    await scheduler.reconcile();
    await scheduler.reconcile();
    scheduler.stop();
    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    expect([...f.rows.values()][0].state).toBe('ambiguous');
    [...f.rows.values()][0].state = 'attempted';
    const restarted = createCommitmentReminderScheduler(f.options);
    await restarted.reconcile();
    restarted.stop();
    expect(f.adapter.submit).toHaveBeenCalledTimes(1);
  });
  it.each(['denied', 'unsupported'] as const)(
    'does not retry %s submission',
    async (outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const f = fixture();
      f.adapter.submit.mockResolvedValue(outcome);
      const scheduler = createCommitmentReminderScheduler(f.options);
      await scheduler.reconcile();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      scheduler.stop();
      expect(f.adapter.submit).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds explicit retries to three while relevant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    f.adapter.submit.mockResolvedValue('failed');
    const scheduler = createCommitmentReminderScheduler(f.options);
    await scheduler.reconcile();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    scheduler.stop();
    expect(f.adapter.submit).toHaveBeenCalledTimes(3);
  });
  it('schedules one next timer, skips stale catchup and blocked permission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    f.adapter.available.mockReturnValue(false);
    const scheduler = createCommitmentReminderScheduler(f.options);
    await scheduler.reconcile();
    expect(vi.getTimerCount()).toBe(1);
    expect(f.adapter.submit).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 86_400_000);
    await scheduler.reconcile();
    expect([...f.rows.values()][0].state).toBe('canceled');
    scheduler.stop();
  });
  it('allows a material new date and invalidates old pending revision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    const scheduler = createCommitmentReminderScheduler(f.options);
    await scheduler.reconcile();
    f.setCandidate({ ...candidate, due_date: '2026-03-10' });
    await scheduler.reconcile();
    await vi.advanceTimersByTimeAsync(22 * 3_600_000);
    scheduler.stop();
    expect(f.adapter.submit).toHaveBeenCalledTimes(2);
  });
});
