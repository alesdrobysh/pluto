import {
  getCommitmentState,
  parseActionMetadata,
} from '../src/utils/actionCommitment';

export interface ReminderCandidate {
  id: string;
  obligationId: string;
  type?: string;
  name: string;
  status: string | null;
  due_date: string | null;
  metadata: string | null;
  /** Authoritative DB lifecycle/identity checks, including aliases and attention suppression. */
  retired?: boolean;
  suppressed?: boolean;
  continuityUncertain?: boolean;
  sourceMeetingId?: string | null;
  verifiedOtherOwnerName?: string | null;
}

export interface ReminderSchedule {
  obligationId: string;
  entityId: string;
  deadlineRevision: string;
  scheduledAt: number;
  expiresAt: number;
}
export type ReminderDecision =
  | { eligible: true; schedule: ReminderSchedule }
  | { eligible: false; reason: string };

const DAY = 86_400_000;
const dateParts = (instant: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
};
const calendarStamp = (p: { year: number; month: number; day: number }) =>
  Date.UTC(p.year, p.month - 1, p.day);

/** Convert a local calendar hour without assuming that a day is 24 hours (DST). */
const localHour = (day: number, hour: number, timeZone: string): number => {
  const target = day + hour * 3_600_000;
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = dateParts(instant, timeZone);
    const represented =
      calendarStamp(p) +
      p.hour * 3_600_000 +
      p.minute * 60_000 +
      p.second * 1_000;
    const correction = target - represented;
    instant += correction;
    if (!correction) break;
  }
  return instant;
};

export function normalizeReminderDeadline(
  value: string | null,
):
  | { revision: string; kind: 'date'; day: number }
  | { revision: string; kind: 'timestamp'; instant: number }
  | null {
  if (!value) return null;
  const text = value.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) {
    const day = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (new Date(day).toISOString().slice(0, 10) !== text) return null;
    return { revision: `date:${text}`, kind: 'date', day };
  }
  const timestamp =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!timestamp || !normalizeReminderDeadline(timestamp[1])) return null;
  if (
    Number(timestamp[2]) > 23 ||
    Number(timestamp[3]) > 59 ||
    Number(timestamp[4] ?? 0) > 59
  )
    return null;
  if (timestamp[6] !== 'Z') {
    const [hours, minutes] = timestamp[6].slice(1).split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
  }
  const instant = Date.parse(text);
  return Number.isFinite(instant)
    ? { revision: `instant:${instant}`, kind: 'timestamp', instant }
    : null;
}

export function evaluateCommitmentReminder(
  candidate: ReminderCandidate,
  context: { now: number; timeZone: string },
): ReminderDecision {
  if (candidate.type && candidate.type !== 'action_item')
    return { eligible: false, reason: 'not_action' };
  if (getCommitmentState(candidate.metadata) !== 'confirmed')
    return { eligible: false, reason: 'not_confirmed' };
  const metadata = parseActionMetadata(candidate.metadata);
  if (
    candidate.retired ||
    typeof metadata.meeting_regeneration_retired_at === 'string'
  )
    return { eligible: false, reason: 'retired' };
  if (candidate.continuityUncertain || !candidate.obligationId)
    return { eligible: false, reason: 'uncertain_identity' };
  if (candidate.suppressed || candidate.status !== 'active')
    return { eligible: false, reason: 'inactive' };
  const deadline = normalizeReminderDeadline(candidate.due_date);
  if (!deadline) return { eligible: false, reason: 'invalid_date' };
  const today = calendarStamp(dateParts(context.now, context.timeZone));
  const dueDay =
    deadline.kind === 'date'
      ? deadline.day
      : calendarStamp(dateParts(deadline.instant, context.timeZone));
  const expiresAt =
    deadline.kind === 'timestamp'
      ? deadline.instant
      : localHour(dueDay + DAY, 0, context.timeZone);
  if (context.now >= expiresAt || dueDay < today)
    return { eligible: false, reason: 'overdue' };
  const preceding = localHour(dueDay - DAY, 9, context.timeZone);
  const dueMorning = localHour(dueDay, 9, context.timeZone);
  const scheduledAt =
    context.now <= preceding
      ? preceding
      : context.now <= dueMorning
        ? dueMorning
        : context.now;
  // An early explicit deadline takes precedence over the normal morning slot.
  if (scheduledAt >= expiresAt)
    return { eligible: false, reason: 'no_relevant_slot' };
  return {
    eligible: true,
    schedule: {
      obligationId: candidate.obligationId,
      entityId: candidate.id,
      deadlineRevision: deadline.revision,
      scheduledAt,
      expiresAt,
    },
  };
}

export function commitmentReminderBody(
  candidate: ReminderCandidate,
  now: number,
  timeZone: string,
  privatePreview = true,
): string {
  const deadline = normalizeReminderDeadline(candidate.due_date);
  const today = calendarStamp(dateParts(now, timeZone));
  const due =
    deadline?.kind === 'date'
      ? deadline.day
      : deadline
        ? calendarStamp(dateParts(deadline.instant, timeZone))
        : today;
  const relation = due > today ? 'tomorrow' : 'today';
  if (privatePreview) return `A commitment is due ${relation}`;
  const task = candidate.name.replace(/[.。]+$/, '');
  return candidate.verifiedOtherOwnerName
    ? `Follow up with ${candidate.verifiedOtherOwnerName}: ${task} is due ${relation}`
    : `${task} is due ${relation}`;
}
