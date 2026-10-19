import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReminderPersistence } from '../../electron/commitmentReminderPersistence';
import { evaluateCommitmentReminder } from '../../electron/commitmentReminderPolicy';
import { createCommitmentReminderStore } from '../../electron/commitmentReminderStore';

let sql: Database.Database;
let api: Parameters<typeof createReminderPersistence>[0];
const now = Date.parse('2026-10-10T16:00:00.000Z');
beforeEach(() => {
  sql = new Database(':memory:');
  sql.exec(`CREATE TABLE entities(id TEXT PRIMARY KEY,type TEXT,name TEXT,due_date TEXT,status TEXT,metadata TEXT,assigned_to TEXT);
    CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE meeting_entities(meeting_id TEXT,entity_id TEXT);
    CREATE TABLE commitment_aliases(extraction_id TEXT PRIMARY KEY,canonical_id TEXT,meeting_id TEXT,active INTEGER,original_json TEXT);
    CREATE TABLE attention_items(id TEXT PRIMARY KEY,status TEXT,related_entity_ids_json TEXT);
    INSERT INTO meetings VALUES ('meeting-1','Fictional planning');`);
  sql.exec(fs.readFileSync('drizzle/0019_commitment_reminders.sql', 'utf8'));
  api = {
    commitmentReminderStore: createCommitmentReminderStore(sql),
    getEntity: vi.fn((id) =>
      sql.prepare('SELECT * FROM entities WHERE id = ?').get(id),
    ),
    getMeeting: vi.fn((id) =>
      sql.prepare('SELECT * FROM meetings WHERE id = ?').get(id),
    ),
    getEntityMeetings: () => [],
    isRetiredCommitment: (id) =>
      !!sql
        .prepare(
          'SELECT 1 FROM commitment_aliases WHERE extraction_id = ? AND active = 1',
        )
        .get(id),
    resolvePersonIdentityId: (id) => id,
    identityStore: {
      getSelfPersonId: () => 'self-person',
      getProfile: () => ({ preferredName: 'Alex', aliases: ['Alex Morgan'] }),
    },
  } as unknown as Parameters<typeof createReminderPersistence>[0];
});
afterEach(() => sql.close());
function insert(id = 'action-1', extra: Record<string, unknown> = {}) {
  sql.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?)').run(
    id,
    'action_item',
    'Prepare example',
    '2026-10-11',
    'active',
    JSON.stringify({
      commitment_state: 'confirmed',
      source_meeting_id: 'meeting-1',
      origin: 'extraction',
      ...extra,
    }),
    null,
  );
}
describe('reminder persistence integration', () => {
  it('recognizes self aliases from structured assignee metadata', () => {
    insert('alias-owner', { assignee_name: 'Alex Morgan' });
    const persistence = createReminderPersistence(api, () => 'UTC');
    expect(persistence.getCandidate('alias-owner')?.id).toBe('alias-owner');
  });
  it('excludes canonical other owners even when review state or assignee text says mine', () => {
    insert('other', { assignee_name: 'Me' });
    sql
      .prepare(
        "UPDATE entities SET assigned_to = 'other-person' WHERE id = 'other'",
      )
      .run();
    const persistence = createReminderPersistence(api, () => 'UTC');
    expect(persistence.getCandidate('other')).toBeUndefined();
    sql
      .prepare(
        "UPDATE entities SET assigned_to = 'self-alias' WHERE id = 'other'",
      )
      .run();
    api.resolvePersonIdentityId = (id) =>
      id === 'self-alias' ? 'self-person' : id;
    expect(persistence.getCandidate('other')?.id).toBe('other');
  });
  it('reuses suppression only while the authoritative mutation revision matches', async () => {
    insert();
    const persistence = createReminderPersistence(api, () => 'UTC');
    await persistence.listCandidates(now);
    const suppression = vi.spyOn(
      api.commitmentReminderStore,
      'suppressedEntityIds',
    );
    expect(persistence.getCandidate('action-1')?.suppressed).toBe(false);
    expect(suppression).not.toHaveBeenCalled();
    sql
      .prepare('INSERT INTO attention_items VALUES (?,?,?)')
      .run('attention-1', 'snoozed', '["action-1"]');
    expect(persistence.getCandidate('action-1')?.suppressed).toBe(true);
    expect(suppression).toHaveBeenCalledTimes(1);
  });
  it('advances bounded cleanup beyond unchanged pending rows', () => {
    const persistence = createReminderPersistence(api, () => 'UTC');
    const schedules = Array.from({ length: 501 }, (_, index) => ({
      obligationId: `obligation-${index}`,
      entityId: `action-${index}`,
      deadlineRevision: 'date:2026-10-11',
      scheduledAt: now,
      expiresAt: now + 86400000,
    }));
    persistence.reconcile(schedules, now);
    persistence.reconcile(schedules.slice(0, 500), now);
    persistence.reconcile(schedules.slice(0, 500), now);
    expect(
      api.commitmentReminderStore.getByObligationRevision(
        'obligation-500',
        'date:2026-10-11',
      )?.state,
    ).toBe('cancelled');
  });
  it('withholds source-less extracted obligations without blocking explicit user work', () => {
    insert('orphan-extraction', { source_meeting_id: null });
    insert('user-action', { source_meeting_id: null, origin: 'user' });
    const persistence = createReminderPersistence(api, () => 'UTC');
    expect(persistence.getCandidate('orphan-extraction')).toBeUndefined();
    expect(persistence.getCandidate('user-action')?.id).toBe('user-action');
  });
  it('loads an indexed deadline window in pages and caches unchanged candidate reads', async () => {
    for (let i = 0; i < 205; i++) insert(`action-${i}`);
    sql
      .prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?)')
      .run(
        'far-future',
        'action_item',
        'Future example',
        '2027-01-01',
        'active',
        '{}',
        null,
      );
    const list = vi.spyOn(api.commitmentReminderStore, 'listCandidates');
    const persistence = createReminderPersistence(
      api,
      () => 'America/Los_Angeles',
    );
    expect(await persistence.listCandidates(now)).toHaveLength(205);
    expect(list).toHaveBeenCalledTimes(2);
    const reads = vi.mocked(api.getEntity).mock.calls.length;
    expect(await persistence.listCandidates(now + 1000)).toHaveLength(205);
    expect(list).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.getEntity).mock.calls).toHaveLength(reads);
  });
  it('honors direct completion, date removal, suppression and deleted source before dispatch', async () => {
    insert();
    const persistence = createReminderPersistence(api, () => 'UTC');
    expect(await persistence.listCandidates(now)).toHaveLength(1);
    sql
      .prepare("UPDATE entities SET status = 'completed' WHERE id = 'action-1'")
      .run();
    expect(await persistence.listCandidates(now)).toHaveLength(0);
    expect(persistence.getCandidate('action-1')).toBeUndefined();
    sql
      .prepare(
        "UPDATE entities SET status = 'active', due_date = NULL WHERE id = 'action-1'",
      )
      .run();
    expect(await persistence.listCandidates(now)).toHaveLength(0);
    sql
      .prepare(
        "UPDATE entities SET due_date = '2026-10-11' WHERE id = 'action-1'",
      )
      .run();
    sql
      .prepare('INSERT INTO attention_items VALUES (?,?,?)')
      .run('attention-1', 'snoozed', '["action-1"]');
    expect((await persistence.listCandidates(now))[0]?.suppressed).toBe(true);
    sql.prepare("UPDATE attention_items SET status = 'active'").run();
    expect(persistence.getCandidate('action-1')?.suppressed).toBe(false);
    sql.prepare("DELETE FROM meetings WHERE id = 'meeting-1'").run();
    expect(persistence.getCandidate('action-1')).toBeUndefined();
    expect(await persistence.listCandidates(now)).toHaveLength(0);
  });
  it('withholds uncertain extraction continuity while honoring explicit user commitments', async () => {
    insert();
    insert('retired-1', {
      meeting_regeneration_retired_at: '2026-10-10T10:00:00Z',
    });
    const persistence = createReminderPersistence(api, () => 'UTC');
    expect(persistence.getCandidate('action-1')?.continuityUncertain).toBe(
      true,
    );
    sql.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run(
      JSON.stringify({
        commitment_state: 'confirmed',
        source_meeting_id: 'meeting-1',
        origin: 'user',
      }),
      'action-1',
    );
    expect(persistence.getCandidate('action-1')?.continuityUncertain).toBe(
      false,
    );
  });
  it('excludes other owners even when their commitment was explicitly confirmed', () => {
    insert('action-1', { owner_source: 'user' });
    sql
      .prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?)')
      .run('other-person', 'person', 'Alex', null, null, '{}', null);
    sql
      .prepare(
        "UPDATE entities SET assigned_to = 'other-person' WHERE id = 'action-1'",
      )
      .run();
    const persistence = createReminderPersistence(api, () => 'UTC');
    expect(persistence.getCandidate('action-1')).toBeUndefined();
    sql
      .prepare(
        "UPDATE entities SET assigned_to = 'self-person' WHERE id = 'action-1'",
      )
      .run();
    expect(
      persistence.getCandidate('action-1')?.verifiedOtherOwnerName,
    ).toBeNull();
  });
  it('preserves durable claims across wrapper restarts and cancels invalid revisions', async () => {
    insert();
    const persistence = createReminderPersistence(api, () => 'UTC');
    const value = persistence.getCandidate('action-1')!;
    const decision = evaluateCommitmentReminder(value, {
      now,
      timeZone: 'UTC',
    });
    if (!decision.eligible) throw new Error('expected fixture eligible');
    const pending = persistence.reconcile([decision.schedule], now)[0];
    expect(persistence.claim(pending, pending.scheduledAt)).toBe(true);
    persistence.finish(pending, 'submitted', pending.scheduledAt, null);
    expect(
      createReminderPersistence(api).reconcile([decision.schedule], now),
    ).toEqual([]);
    const changed = {
      ...decision.schedule,
      deadlineRevision: 'date:2026-10-12',
    };
    expect(persistence.reconcile([changed], now)).toHaveLength(1);
    persistence.reconcile([], now);
    expect(api.commitmentReminderStore.listScheduled()).toEqual([]);
  });
});
