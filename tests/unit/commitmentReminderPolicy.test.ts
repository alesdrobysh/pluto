import { describe, expect, it } from 'vitest';
import {
  type ReminderCandidate,
  commitmentReminderBody,
  evaluateCommitmentReminder,
  normalizeReminderDeadline,
} from '../../electron/commitmentReminderPolicy';
const item: ReminderCandidate = {
  id: 'a',
  obligationId: 'a',
  name: 'Send estimate',
  status: 'active',
  due_date: '2026-03-09',
  metadata: '{"commitment_state":"confirmed"}',
};
const evaluate = (
  now: string,
  changes: Partial<ReminderCandidate> = {},
  timeZone = 'America/Los_Angeles',
) =>
  evaluateCommitmentReminder(
    { ...item, ...changes },
    { now: Date.parse(now), timeZone },
  );
describe('commitment reminder policy', () => {
  it('schedules 9am preceding calendar day across spring DST', () => {
    const result = evaluate('2026-03-07T12:00:00Z');
    expect(
      result.eligible && new Date(result.schedule.scheduledAt).toISOString(),
    ).toBe('2026-03-08T16:00:00.000Z');
  });
  it('handles fall DST and timezone changes as local dates', () => {
    for (const [zone, expected] of [
      ['America/Los_Angeles', '2026-11-01T17:00:00.000Z'],
      ['America/New_York', '2026-11-01T14:00:00.000Z'],
    ]) {
      const result = evaluate(
        '2026-10-31T12:00:00Z',
        { due_date: '2026-11-02' },
        zone,
      );
      expect(
        result.eligible && new Date(result.schedule.scheduledAt).toISOString(),
      ).toBe(expected);
    }
  });
  it('falls back to due morning then same-day immediate catchup', () => {
    const morning = evaluate('2026-03-08T18:00:00Z');
    expect(
      morning.eligible && new Date(morning.schedule.scheduledAt).toISOString(),
    ).toBe('2026-03-09T16:00:00.000Z');
    const catchup = evaluate('2026-03-09T18:00:00Z');
    expect(catchup.eligible && catchup.schedule.scheduledAt).toBe(
      Date.parse('2026-03-09T18:00:00Z'),
    );
    expect(evaluate('2026-03-10T08:00:00Z').eligible).toBe(false);
  });
  it.each([
    null,
    '{}',
    '{"commitment_state":"possible"}',
    '{"commitment_state":"rejected"}',
  ])('requires confirmation: %s', (metadata) =>
    expect(evaluate('2026-03-07T12:00:00Z', { metadata }).eligible).toBe(false),
  );
  it.each(['completed', 'deleted', 'deferred', 'suppressed', 'archived', null])(
    'excludes lifecycle %s',
    (status) =>
      expect(evaluate('2026-03-07T12:00:00Z', { status }).eligible).toBe(false),
  );
  it.each([
    { retired: true },
    { suppressed: true },
    { continuityUncertain: true },
    {
      metadata:
        '{"commitment_state":"confirmed","meeting_regeneration_retired_at":"2026-03-01"}',
    },
  ])('excludes invalid authority %j', (changes) =>
    expect(evaluate('2026-03-07T12:00:00Z', changes).eligible).toBe(false),
  );
  it.each([
    'tomorrow',
    '03/09/2026',
    '2026-02-30',
    '2026-03-09T09:00:00',
    '2026-03-09T25:00:00Z',
    '2026-03-09T09:60:00Z',
    '2026-03-09T09:00:00+25:00',
    '',
  ])('rejects noncanonical date %s', (due_date) =>
    expect(evaluate('2026-03-07T12:00:00Z', { due_date }).eligible).toBe(false),
  );
  it('canonicalizes timestamp formatting and offset equivalents', () => {
    expect(normalizeReminderDeadline('2026-03-09T09:00-07:00')?.revision).toBe(
      normalizeReminderDeadline('2026-03-09T16:00:00.000Z')?.revision,
    );
    expect(normalizeReminderDeadline('2026-03-09')?.revision).not.toBe(
      normalizeReminderDeadline('2026-03-09T00:00:00Z')?.revision,
    );
  });
  it('never delivers after an explicit timestamp', () => {
    expect(
      evaluate('2026-03-09T17:00:00Z', {
        due_date: '2026-03-09T09:00:00-07:00',
      }).eligible,
    ).toBe(false);
  });
  it('uses generic privacy copy and only verified other-owner copy', () => {
    expect(
      commitmentReminderBody(
        item,
        Date.parse('2026-03-08T18:00:00Z'),
        'America/Los_Angeles',
      ),
    ).toBe('A commitment is due tomorrow');
    expect(
      commitmentReminderBody(
        { ...item, verifiedOtherOwnerName: 'Alex' },
        Date.parse('2026-03-08T18:00:00Z'),
        'America/Los_Angeles',
        false,
      ),
    ).toBe('Follow up with Alex: Send estimate is due tomorrow');
  });
});
