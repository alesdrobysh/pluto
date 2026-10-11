import type Database from 'better-sqlite3';
import type { Entity } from './db';

export interface ReminderLedgerRow {
  id: number;
  obligationId: string;
  entityId: string;
  deadlineRevision: string;
  scheduledAt: string;
  state: 'pending' | 'attempted' | 'submitted' | 'failed' | 'cancelled';
  attemptCount: number;
  attemptedAt: string | null;
  submittedAt: string | null;
  retryAt: string | null;
}

const projection = `id, obligation_id AS obligationId, entity_id AS entityId,
  deadline_key AS deadlineRevision, scheduled_at AS scheduledAt, state,
  attempt_count AS attemptCount, attempted_at AS attemptedAt,
  submitted_at AS submittedAt, retry_at AS retryAt`;
const bounded = (limit: number) =>
  Math.max(1, Math.min(500, Math.floor(limit)));

/** This ledger contains delivery history only. Entity state remains authoritative. */
export function createCommitmentReminderStore(db: Database.Database) {
  const get = (id: number) =>
    db
      .prepare(
        `SELECT ${projection} FROM commitment_reminder_ledger WHERE id = ?`,
      )
      .get(id) as ReminderLedgerRow | undefined;
  const cancelPending = (obligationId: string, exceptDeadlineRevision = '') => {
    db.prepare(`UPDATE commitment_reminder_ledger SET state = 'cancelled', retry_at = NULL
      WHERE obligation_id = ? AND deadline_key != ? AND state IN ('pending','failed')`).run(
      obligationId,
      exceptDeadlineRevision,
    );
  };
  return {
    get,
    rescheduleFuturePending: (id: number, scheduledAt: string, now: string) => {
      if (scheduledAt <= now) return;
      db.prepare(`UPDATE commitment_reminder_ledger SET scheduled_at = ?
        WHERE id = ? AND state = 'pending' AND attempt_count = 0 AND scheduled_at > ?`).run(
        scheduledAt,
        id,
        now,
      );
    },
    sourceExists: (meetingId: string) =>
      !!db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(meetingId),
    sourceMeetingId: (entityId: string) =>
      (
        db
          .prepare(
            'SELECT meeting_id FROM meeting_entities WHERE entity_id = ? ORDER BY meeting_id LIMIT 1',
          )
          .get(entityId) as { meeting_id: string } | undefined
      )?.meeting_id ?? null,
    suppressedEntityIds: (entityIds: string[]): Set<string> => {
      if (!entityIds.length) return new Set();
      if (entityIds.length > 500)
        throw new Error('reminder_suppression_batch_too_large');
      const placeholders = entityIds.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT related.value AS id FROM attention_items a,
        json_each(CASE WHEN json_valid(a.related_entity_ids_json) THEN a.related_entity_ids_json ELSE '[]' END) related
        WHERE related.value IN (${placeholders}) GROUP BY related.value
        HAVING MIN(CASE WHEN a.status IN ('dismissed','snoozed') THEN 1 ELSE 0 END) = 1`)
        .all(...entityIds) as { id: string }[];
      return new Set(rows.map((row) => row.id));
    },
    getByObligationRevision: (obligationId: string, deadlineRevision: string) =>
      db
        .prepare(
          `SELECT ${projection} FROM commitment_reminder_ledger WHERE obligation_id = ? AND deadline_key = ?`,
        )
        .get(obligationId, deadlineRevision) as ReminderLedgerRow | undefined,
    schedule: (input: {
      obligationId: string;
      entityId: string;
      deadlineRevision: string;
      scheduledAt: string;
    }): ReminderLedgerRow =>
      db.transaction(() => {
        cancelPending(input.obligationId, input.deadlineRevision);
        db.prepare(`INSERT INTO commitment_reminder_ledger(obligation_id,entity_id,deadline_key,scheduled_at)
        VALUES (?,?,?,?) ON CONFLICT(obligation_id,deadline_key) DO UPDATE SET
        entity_id = excluded.entity_id,
        scheduled_at = CASE WHEN state = 'cancelled' THEN excluded.scheduled_at ELSE scheduled_at END,
        state = CASE WHEN state = 'cancelled' AND attempt_count = 0 THEN 'pending' ELSE state END`).run(
          input.obligationId,
          input.entityId,
          input.deadlineRevision,
          input.scheduledAt,
        );
        return db
          .prepare(
            `SELECT ${projection} FROM commitment_reminder_ledger WHERE obligation_id = ? AND deadline_key = ?`,
          )
          .get(input.obligationId, input.deadlineRevision) as ReminderLedgerRow;
      })(),
    listDue: (now: string, limit = 100) =>
      db
        .prepare(`SELECT ${projection} FROM commitment_reminder_ledger
      WHERE (state = 'pending' AND scheduled_at <= ?) OR (state = 'failed' AND retry_at <= ? AND attempt_count < 3)
      ORDER BY COALESCE(retry_at, scheduled_at), id LIMIT ?`)
        .all(now, now, bounded(limit)) as ReminderLedgerRow[],
    listScheduled: (limit = 200) =>
      db
        .prepare(`SELECT ${projection} FROM commitment_reminder_ledger
      WHERE state = 'pending' OR (state = 'failed' AND retry_at IS NOT NULL AND attempt_count < 3)
      ORDER BY COALESCE(retry_at, scheduled_at), id LIMIT ?`)
        .all(bounded(limit)) as ReminderLedgerRow[],
    listPendingCleanup: (afterId: number, limit = 500) =>
      db
        .prepare(`SELECT ${projection} FROM commitment_reminder_ledger
      WHERE id > ? AND state IN ('pending','failed') ORDER BY id LIMIT ?`)
        .all(afterId, bounded(limit)) as ReminderLedgerRow[],
    // Claim before calling the OS. An attempted row after a crash is ambiguous:
    // never automatically reclaim it, since the OS may already have accepted it.
    claim: (id: number, now: string) =>
      db
        .prepare(`UPDATE commitment_reminder_ledger
      SET state = 'attempted', attempt_count = attempt_count + 1, attempted_at = ?, retry_at = NULL
      WHERE id = ? AND attempt_count < 3 AND ((state = 'pending' AND scheduled_at <= ?)
      OR (state = 'failed' AND retry_at <= ?))`)
        .run(now, id, now, now).changes === 1,
    submitted: (id: number, now: string) => {
      db.prepare(`UPDATE commitment_reminder_ledger SET state = 'submitted', submitted_at = ?, failure_code = NULL
      WHERE id = ? AND state = 'attempted'`).run(now, id);
    },
    failed: (id: number, code: string, retryAt: string | null) => {
      db.prepare(`UPDATE commitment_reminder_ledger
      SET state = 'failed', failure_code = ?, retry_at = CASE WHEN attempt_count < 3 THEN ? ELSE NULL END
      WHERE id = ? AND state = 'attempted'`).run(
        code.slice(0, 80),
        retryAt,
        id,
      );
    },
    cancelPending,
    cancelAllPending: () => {
      db.prepare(
        `UPDATE commitment_reminder_ledger SET state = 'cancelled', retry_at = NULL WHERE state IN ('pending','failed')`,
      ).run();
    },
    listCandidates: (
      earliestDate: string,
      latestDate: string,
      limit = 200,
      after?: { dueDate: string; id: string },
    ) =>
      db
        .prepare(`SELECT * FROM entities
      WHERE type = 'action_item' AND due_date >= ? AND due_date <= ?
        AND (due_date, id) > (?, ?) ORDER BY due_date, id LIMIT ?`)
        .all(
          earliestDate,
          latestDate,
          after?.dueDate ?? '',
          after?.id ?? '',
          bounded(limit),
        ) as Entity[],
    revision: () =>
      (
        db
          .prepare(
            'SELECT revision FROM commitment_reminder_revision WHERE singleton = 1',
          )
          .get() as { revision: number }
      ).revision,
    changes: (limit = 200) =>
      db
        .prepare(
          'SELECT entity_id AS entityId, revision FROM commitment_reminder_changes ORDER BY revision, entity_id LIMIT ?',
        )
        .all(bounded(limit)) as { entityId: string; revision: number }[],
    acknowledgeChanges: (changes: { entityId: string; revision: number }[]) =>
      db.transaction(() => {
        const remove = db.prepare(
          'DELETE FROM commitment_reminder_changes WHERE entity_id = ? AND revision = ?',
        );
        for (const change of changes)
          remove.run(change.entityId, change.revision);
      })(),
    resolveObligationId: (entityId: string): string | null => {
      const seen = new Set<string>();
      let id = entityId;
      while (!seen.has(id)) {
        seen.add(id);
        const alias = db
          .prepare(
            'SELECT canonical_id, original_json FROM commitment_aliases WHERE extraction_id = ? AND active = 1',
          )
          .get(id) as
          | { canonical_id: string; original_json: string | null }
          | undefined;
        if (!alias) return id;
        try {
          const proof = JSON.parse(alias.original_json || '{}').identityProof;
          if (
            !proof?.ownerKey ||
            !proof.candidateFingerprint ||
            !proof.canonicalFingerprint
          )
            return null;
        } catch {
          return null;
        }
        id = alias.canonical_id;
      }
      return null;
    },
    hasUnresolvedRegeneration: (
      entityId: string,
      meetingId: string,
    ): boolean => {
      const prior = db
        .prepare(`SELECT 1 FROM entities WHERE type = 'action_item' AND id != ?
        AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.source_meeting_id') = ?
        AND json_type(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.meeting_regeneration_retired_at') = 'text' LIMIT 1`)
        .get(entityId, meetingId);
      if (!prior) return false;
      const verified = db
        .prepare(`SELECT 1 FROM commitment_aliases WHERE canonical_id = ? AND meeting_id = ? AND active = 1
        AND EXISTS (SELECT 1 FROM entities prior WHERE prior.id = commitment_aliases.extraction_id
          AND prior.type = 'action_item'
          AND json_extract(CASE WHEN json_valid(prior.metadata) THEN prior.metadata ELSE '{}' END, '$.source_meeting_id') = commitment_aliases.meeting_id
          AND json_type(CASE WHEN json_valid(prior.metadata) THEN prior.metadata ELSE '{}' END, '$.meeting_regeneration_retired_at') = 'text')
        AND length(json_extract(CASE WHEN json_valid(original_json) THEN original_json ELSE '{}' END, '$.identityProof.ownerKey')) > 0
        AND length(json_extract(CASE WHEN json_valid(original_json) THEN original_json ELSE '{}' END, '$.identityProof.candidateFingerprint')) > 0
        AND length(json_extract(CASE WHEN json_valid(original_json) THEN original_json ELSE '{}' END, '$.identityProof.canonicalFingerprint')) > 0 LIMIT 1`)
        .get(entityId, meetingId);
      return !verified;
    },
  };
}
