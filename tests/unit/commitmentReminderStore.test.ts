import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommitmentReminderStore } from '../../electron/commitmentReminderStore';

let db: Database.Database;
let store: ReturnType<typeof createCommitmentReminderStore>;
const now = '2026-10-10T16:00:00.000Z';
const schedule = {
  obligationId: 'obligation-1',
  entityId: 'action-1',
  deadlineRevision: 'date:2026-10-11',
  scheduledAt: now,
};
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE entities(id TEXT PRIMARY KEY,type TEXT,name TEXT,due_date TEXT,status TEXT,metadata TEXT);
    CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE meeting_entities(meeting_id TEXT,entity_id TEXT);
    CREATE TABLE commitment_aliases(extraction_id TEXT PRIMARY KEY,canonical_id TEXT,meeting_id TEXT,active INTEGER,original_json TEXT);
    CREATE TABLE attention_items(id TEXT PRIMARY KEY,status TEXT,related_entity_ids_json TEXT);
    INSERT INTO entities VALUES ('action-1','action_item','Prepare example','2026-10-11','active','{}');
    INSERT INTO meetings VALUES ('meeting-1','Fictional planning');`);
  db.exec(fs.readFileSync('drizzle/0019_commitment_reminders.sql', 'utf8'));
  store = createCommitmentReminderStore(db);
});
afterEach(() => db.close());

describe('commitment reminder delivery ledger', () => {
  it('migrates without changing commitments or notes and bounds deadline reads', () => {
    expect(db.prepare('SELECT name FROM entities').get()).toEqual({
      name: 'Prepare example',
    });
    expect(db.prepare('SELECT title FROM meetings').get()).toEqual({
      title: 'Fictional planning',
    });
    expect(store.listCandidates('2026-10-11', '2026-10-14', 1)).toHaveLength(1);
    expect(store.listCandidates('2026-10-12', '2026-10-14', 1)).toHaveLength(0);
    expect(
      store.listCandidates('2026-10-11', '2026-10-14', 1, {
        dueDate: '2026-10-11',
        id: 'action-1',
      }),
    ).toHaveLength(0);
    expect(store.listCandidates('2026-10-09', '2026-10-10', 1)).toHaveLength(0);
  });
  it('claims atomically and suppresses ambiguous restart attempts', () => {
    const row = store.schedule(schedule);
    expect(store.claim(row.id, now)).toBe(true);
    expect(store.claim(row.id, now)).toBe(false);
    const reopened = createCommitmentReminderStore(db);
    expect(reopened.listDue(now)).toEqual([]);
    expect(reopened.schedule(schedule).state).toBe('attempted');
  });
  it('preserves the original pending instant across catch-up reconciliation', () => {
    const row = store.schedule(schedule);
    const reconciled = store.schedule({
      ...schedule,
      scheduledAt: '2026-10-11T16:00:00.000Z',
    });
    expect(reconciled.scheduledAt).toBe(now);
    expect(
      store.getByObligationRevision(
        schedule.obligationId,
        schedule.deadlineRevision,
      )?.id,
    ).toBe(row.id);
    expect(store.listDue(now)).toHaveLength(1);
  });
  it('reschedules only untouched future reminders for timezone changes', () => {
    const future = '2026-10-11T16:00:00.000Z';
    const row = store.schedule({ ...schedule, scheduledAt: future });
    store.rescheduleFuturePending(row.id, '2026-10-11T13:00:00.000Z', now);
    expect(store.get(row.id)?.scheduledAt).toBe('2026-10-11T13:00:00.000Z');
    store.rescheduleFuturePending(
      row.id,
      '2026-10-11T18:00:00.000Z',
      '2026-10-11T14:00:00.000Z',
    );
    expect(store.get(row.id)?.scheduledAt).toBe('2026-10-11T13:00:00.000Z');
  });
  it('retains submitted history across cancellation, reopening and equivalent revisions', () => {
    const row = store.schedule(schedule);
    store.claim(row.id, now);
    store.submitted(row.id, now);
    store.cancelAllPending();
    expect(
      store.schedule({ ...schedule, entityId: 'regenerated-1' }).state,
    ).toBe('submitted');
    expect(store.listDue(now)).toEqual([]);
    const changed = store.schedule({
      ...schedule,
      deadlineRevision: 'date:2026-10-12',
    });
    expect(changed.id).not.toBe(row.id);
    expect(store.listDue(now)).toHaveLength(1);
  });
  it('cancels replaced pending revisions and allows re-enable before delivery', () => {
    const first = store.schedule(schedule);
    const second = store.schedule({
      ...schedule,
      deadlineRevision: 'date:2026-10-12',
    });
    expect(store.get(first.id)?.state).toBe('cancelled');
    store.cancelAllPending();
    expect(
      store.schedule({ ...schedule, deadlineRevision: second.deadlineRevision })
        .state,
    ).toBe('pending');
  });
  it('retries only explicit failures and stops after three attempts', () => {
    const row = store.schedule(schedule);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(store.claim(row.id, now)).toBe(true);
      store.failed(row.id, 'adapter_failure', now);
    }
    expect(store.claim(row.id, now)).toBe(false);
    expect(store.listDue(now)).toEqual([]);
    expect(store.get(row.id)?.attemptCount).toBe(3);
    expect(store.get(row.id)?.retryAt).toBeNull();
  });
  it('coalesces direct SQL changes and keeps a mutation that races acknowledgement', () => {
    db.prepare(
      "UPDATE entities SET status = 'completed' WHERE id = 'action-1'",
    ).run();
    const changes = store.changes();
    db.prepare(
      "UPDATE entities SET due_date = NULL WHERE id = 'action-1'",
    ).run();
    store.acknowledgeChanges(changes);
    expect(store.changes()).toHaveLength(1);
    store.acknowledgeChanges(store.changes());
    expect(store.changes()).toEqual([]);
    db.prepare("DELETE FROM entities WHERE id = 'action-1'").run();
    expect(store.changes()[0]?.entityId).toBe('action-1');
  });
  it('resolves only proof-backed aliases and rejects cycles or missing proof', () => {
    db.prepare('INSERT INTO commitment_aliases VALUES (?,?,?,?,?)').run(
      'new-1',
      'action-1',
      'meeting-1',
      1,
      '{}',
    );
    expect(store.resolveObligationId('new-1')).toBeNull();
    const proof = JSON.stringify({
      identityProof: {
        ownerKey: 'person:p1',
        candidateFingerprint: 'a',
        canonicalFingerprint: 'b',
      },
    });
    db.prepare('UPDATE commitment_aliases SET original_json = ?').run(proof);
    expect(store.resolveObligationId('new-1')).toBe('action-1');
    db.prepare('INSERT INTO commitment_aliases VALUES (?,?,?,?,?)').run(
      'action-1',
      'new-1',
      'meeting-1',
      1,
      proof,
    );
    expect(store.resolveObligationId('new-1')).toBeNull();
  });
  it('withholds a new generation without continuity proof', () => {
    db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?)').run(
      'retired-1',
      'action_item',
      'Old example',
      '2026-10-11',
      'active',
      JSON.stringify({
        source_meeting_id: 'meeting-1',
        meeting_regeneration_retired_at: now,
      }),
    );
    expect(store.hasUnresolvedRegeneration('action-1', 'meeting-1')).toBe(true);
    db.prepare('INSERT INTO commitment_aliases VALUES (?,?,?,?,?)').run(
      'unrelated-new-extraction',
      'action-1',
      'meeting-1',
      1,
      JSON.stringify({
        identityProof: {
          ownerKey: 'person:p1',
          candidateFingerprint: 'a',
          canonicalFingerprint: 'b',
        },
      }),
    );
    expect(store.hasUnresolvedRegeneration('action-1', 'meeting-1')).toBe(true);
    db.prepare('INSERT INTO commitment_aliases VALUES (?,?,?,?,?)').run(
      'retired-1',
      'action-1',
      'meeting-1',
      1,
      JSON.stringify({
        identityProof: {
          ownerKey: 'person:p1',
          candidateFingerprint: 'a',
          canonicalFingerprint: 'b',
        },
      }),
    );
    expect(store.hasUnresolvedRegeneration('action-1', 'meeting-1')).toBe(
      false,
    );
  });
});
