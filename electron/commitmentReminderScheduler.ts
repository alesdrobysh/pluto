import {
  type ReminderCandidate,
  type ReminderSchedule,
  evaluateCommitmentReminder,
} from './commitmentReminderPolicy';

export interface PendingReminder extends ReminderSchedule {
  attempts: number;
  retryAt?: number | null;
}
export type ReminderSubmission =
  | 'submitted'
  | 'failed'
  | 'blocked'
  | 'denied'
  | 'unsupported'
  | 'ambiguous';
export interface ReminderPersistence {
  listCandidates(
    now: number,
  ): ReminderCandidate[] | Promise<ReminderCandidate[]>;
  /** Upsert new schedules, preserve existing delivery history, cancel invalid pending revisions. */
  reconcile(schedules: ReminderSchedule[], now: number): PendingReminder[];
  getCandidate(entityId: string): ReminderCandidate | undefined;
  /** Atomically moves pending/explicit-failure to attempted; attempted is never reclaimed. */
  claim(reminder: PendingReminder, now: number): boolean;
  finish(
    reminder: PendingReminder,
    outcome: ReminderSubmission,
    now: number,
    retryAt: number | null,
  ): void;
}
export interface ReminderAdapter {
  available(): boolean | Promise<boolean>;
  /** A rejection/throw is ambiguous; return failed only when submission certainly did not occur. */
  submit(
    candidate: ReminderCandidate,
    reminder: PendingReminder,
  ): ReminderSubmission | Promise<ReminderSubmission>;
  cancel?(obligationId: string): void;
}
export interface ReminderSchedulerOptions {
  persistence: ReminderPersistence;
  adapter: ReminderAdapter;
  enabled(): boolean;
  ready(): boolean;
  now?(): number;
  timeZone?(): string;
  recoveryIntervalMs?: number;
  onError?(error: unknown): void;
}

/** One main-process timer, serialized sweeps, and durable at-most-one ambiguous attempt.
 * A crash after claim but before OS submission may lose a reminder. This deliberately
 * avoids duplicate visible alerts; submitted means OS submission, never user receipt.
 */
export function createCommitmentReminderScheduler(
  options: ReminderSchedulerOptions,
) {
  const now = options.now ?? Date.now;
  const timeZone =
    options.timeZone ??
    (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const recovery = Math.max(1_000, options.recoveryIntervalMs ?? 15 * 60_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  let activeObligations = new Map<string, string>();
  const safe = () => !stopped && options.ready() && options.enabled();

  const sweep = async () => {
    let nextAt = now() + recovery;
    try {
      if (!safe()) {
        for (const obligationId of activeObligations.keys())
          options.adapter.cancel?.(obligationId);
        activeObligations.clear();
        if (options.ready()) options.persistence.reconcile([], now());
        return;
      }
      const instant = now();
      const candidates = await options.persistence.listCandidates(instant);
      if (!safe()) {
        dirty = true;
        return;
      }
      const schedules = candidates.flatMap((candidate) => {
        const decision = evaluateCommitmentReminder(candidate, {
          now: now(),
          timeZone: timeZone(),
        });
        return decision.eligible ? [decision.schedule] : [];
      });
      // Ask in context as soon as eligible work exists, even before its delivery date.
      const available =
        schedules.length > 0 ? await options.adapter.available() : false;
      if (!safe()) {
        dirty = true;
        return;
      }
      const currentObligations = new Map(
        schedules.map((schedule) => [
          schedule.obligationId,
          schedule.deadlineRevision,
        ]),
      );
      for (const [id, revision] of activeObligations)
        if (currentObligations.get(id) !== revision)
          options.adapter.cancel?.(id);
      activeObligations = currentObligations;
      const pending = options.persistence.reconcile(schedules, instant);
      for (const reminder of pending) {
        const dueAt = reminder.retryAt ?? reminder.scheduledAt;
        if (dueAt > now()) {
          nextAt = Math.min(nextAt, dueAt);
          continue;
        }
        if (!safe()) break;
        if (!available) continue;
        const candidate = options.persistence.getCandidate(reminder.entityId);
        if (!candidate) continue;
        const decision = evaluateCommitmentReminder(candidate, {
          now: now(),
          timeZone: timeZone(),
        });
        if (
          !decision.eligible ||
          decision.schedule.obligationId !== reminder.obligationId ||
          decision.schedule.deadlineRevision !== reminder.deadlineRevision
        )
          continue;
        const previousAttempts = reminder.attempts;
        if (!options.persistence.claim(reminder, now())) continue;
        let outcome: ReminderSubmission;
        try {
          outcome = await options.adapter.submit(candidate, reminder);
        } catch {
          outcome = 'ambiguous';
        }
        const retryAt =
          outcome === 'failed' && previousAttempts < 2
            ? now() + 60_000 * 2 ** previousAttempts
            : null;
        options.persistence.finish(
          reminder,
          outcome,
          now(),
          retryAt !== null && retryAt < decision.schedule.expiresAt
            ? retryAt
            : null,
        );
        if (retryAt !== null && retryAt < decision.schedule.expiresAt)
          nextAt = Math.min(nextAt, retryAt);
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      if (!stopped) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          () => {
            void reconcile();
          },
          Math.max(1, Math.min(recovery, nextAt - now())),
        );
        timer.unref?.();
      }
    }
  };
  const reconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (!running) {
      running = (async () => {
        while (dirty && !stopped) {
          dirty = false;
          await sweep();
        }
      })().finally(() => {
        running = undefined;
      });
    }
    return running;
  };
  return {
    reconcile,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let an in-flight OS submission settle before cancellation and DB close.
      await running;
      for (const id of activeObligations.keys()) options.adapter.cancel?.(id);
      activeObligations.clear();
    },
  };
}
