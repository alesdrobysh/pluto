import { setImmediate } from 'node:timers/promises';
import {
  getActionSourceMeetingId,
  isPersonalAction,
  parseActionMetadata,
} from '../src/utils/actionCommitment';
import type { ReminderCandidate } from './commitmentReminderPolicy';
import type {
  PendingReminder,
  ReminderPersistence,
} from './commitmentReminderScheduler';
import type * as DatabaseApi from './db';

type ReminderDatabase = Pick<
  typeof DatabaseApi,
  | 'commitmentReminderStore'
  | 'getEntity'
  | 'isRetiredCommitment'
  | 'identityStore'
  | 'resolvePersonIdentityId'
>;

const day = 86_400_000;
const iso = (instant: number) => new Date(instant).toISOString();

/** Bounded source reads with a cache of the current four-day delivery window. */
export function createReminderPersistence(
  api: ReminderDatabase,
  timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): ReminderPersistence {
  const store = api.commitmentReminderStore;
  let revision = -1;
  let window = '';
  let lastTimeZone = timeZone();
  let timeZoneChanged = false;
  let cleanupAfterId = 0;
  const candidates = new Map<string, ReminderCandidate>();

  const candidate = (
    entityId: string,
    suppressed?: Set<string>,
  ): ReminderCandidate | undefined => {
    const entity = api.getEntity(entityId);
    if (
      !entity ||
      entity.type !== 'action_item' ||
      api.isRetiredCommitment(entityId)
    )
      return undefined;
    const metadata = parseActionMetadata(entity.metadata);
    const self = api.identityStore.getSelfPersonId();
    const canonicalSelf = self ? api.resolvePersonIdentityId(self) : null;
    const profile = api.identityStore.getProfile();
    const canonicalOwner = entity.assigned_to
      ? api.resolvePersonIdentityId(entity.assigned_to)
      : null;
    if (
      !isPersonalAction(
        { ...entity, assigned_to: canonicalOwner },
        {
          selfPersonId: canonicalSelf,
          selfNames: profile ? [profile.preferredName, ...profile.aliases] : [],
        },
      )
    )
      return undefined;
    const obligationId = store.resolveObligationId(entityId);
    if (!obligationId) return undefined;
    const sourceMeetingId =
      getActionSourceMeetingId(entity.metadata) ??
      store.sourceMeetingId(entityId);
    if (metadata.origin === 'extraction' && !sourceMeetingId) return undefined;
    if (sourceMeetingId && !store.sourceExists(sourceMeetingId))
      return undefined;
    const owner =
      entity.assigned_to && metadata.owner_source === 'user'
        ? api.resolvePersonIdentityId(entity.assigned_to)
        : null;
    const other =
      owner && self && owner !== api.resolvePersonIdentityId(self)
        ? api.getEntity(owner)
        : undefined;
    return {
      ...entity,
      obligationId,
      sourceMeetingId,
      suppressed: (suppressed ?? store.suppressedEntityIds([entityId])).has(
        entityId,
      ),
      continuityUncertain:
        metadata.origin === 'extraction' &&
        !!sourceMeetingId &&
        store.hasUnresolvedRegeneration(entityId, sourceMeetingId),
      verifiedOtherOwnerName: other?.type === 'person' ? other.name : null,
    };
  };
  return {
    async listCandidates(now) {
      const currentTimeZone = timeZone();
      timeZoneChanged ||= currentTimeZone !== lastTimeZone;
      lastTimeZone = currentTimeZone;
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: currentTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
      const read = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value);
      const today = Date.UTC(read('year'), read('month') - 1, read('day'));
      const earliest = iso(today - day).slice(0, 10);
      const latest = `${iso(today + 3 * day).slice(0, 10)}T99`;
      const nextWindow = `${earliest}:${latest}`;
      const currentRevision = store.revision();
      if (window !== nextWindow) {
        candidates.clear();
        let after: { dueDate: string; id: string } | undefined;
        while (true) {
          const entities = store.listCandidates(earliest, latest, 200, after);
          const suppressed = store.suppressedEntityIds(
            entities.map((entity) => entity.id),
          );
          for (const entity of entities) {
            const value = candidate(entity.id, suppressed);
            if (value) candidates.set(entity.id, value);
          }
          if (entities.length < 200) break;
          const last = entities.at(-1)!;
          after = { dueDate: last.due_date!, id: last.id };
          await setImmediate();
        }
        window = nextWindow;
      }
      if (revision !== currentRevision) {
        while (true) {
          const changes = store.changes(200);
          if (!changes.length) break;
          const suppressed = store.suppressedEntityIds(
            changes.map((change) => change.entityId),
          );
          for (const change of changes) {
            const value = candidate(change.entityId, suppressed);
            if (
              value?.due_date &&
              value.due_date >= earliest &&
              value.due_date <= latest
            )
              candidates.set(change.entityId, value);
            else candidates.delete(change.entityId);
          }
          store.acknowledgeChanges(changes);
          if (changes.length < 200) break;
          await setImmediate();
        }
      }
      revision = currentRevision;
      return [...candidates.values()];
    },
    getCandidate: (entityId) => {
      // The durable revision covers entity, alias, attention and source deletion
      // mutations. Reuse only suppression membership from that exact revision;
      // all authoritative commitment/source/identity fields are still reread.
      const cached =
        store.revision() === revision ? candidates.get(entityId) : undefined;
      return candidate(
        entityId,
        cached ? new Set(cached.suppressed ? [entityId] : []) : undefined,
      );
    },
    reconcile(schedules, now) {
      const desired = new Map(
        schedules.map((schedule) => [schedule.obligationId, schedule]),
      );
      // Bounded removal progresses on recovery sweeps; history remains durable.
      const cleanup = store.listPendingCleanup(cleanupAfterId);
      for (const row of cleanup) {
        const current = desired.get(row.obligationId);
        if (!current || current.deadlineRevision !== row.deadlineRevision)
          store.cancelPending(row.obligationId, current?.deadlineRevision);
      }
      cleanupAfterId = cleanup.length === 500 ? cleanup.at(-1)!.id : 0;
      const pending: PendingReminder[] = [];
      for (const schedule of desired.values()) {
        let row = store.schedule({
          ...schedule,
          scheduledAt: iso(schedule.scheduledAt),
        });
        if (timeZoneChanged) {
          store.rescheduleFuturePending(
            row.id,
            iso(schedule.scheduledAt),
            iso(now),
          );
          row = store.get(row.id)!;
        }
        if (
          row.state !== 'pending' &&
          !(row.state === 'failed' && row.retryAt && row.attemptCount < 3)
        )
          continue;
        pending.push({
          ...schedule,
          scheduledAt: Date.parse(row.scheduledAt),
          attempts: row.attemptCount,
          retryAt: row.retryAt ? Date.parse(row.retryAt) : null,
        });
      }
      timeZoneChanged = false;
      return pending;
    },
    claim(reminder, now) {
      const row = store.getByObligationRevision(
        reminder.obligationId,
        reminder.deadlineRevision,
      );
      return !!row && store.claim(row.id, iso(now));
    },
    finish(reminder, outcome, now, retryAt) {
      const row = store.getByObligationRevision(
        reminder.obligationId,
        reminder.deadlineRevision,
      );
      if (!row) return;
      if (outcome === 'submitted') store.submitted(row.id, iso(now));
      else if (outcome !== 'ambiguous')
        store.failed(
          row.id,
          outcome,
          outcome === 'failed' && retryAt !== null ? iso(retryAt) : null,
        );
    },
  };
}
