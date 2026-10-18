import { normalizeReminderDeadline } from './commitmentReminderPolicy';

/** Normalize supported dates using the source meeting calendar, never extraction time. */
export function parseDueDate(
  dueDate: string,
  meetingStartedAt?: string | null,
  timeZone?: string,
): string | null {
  if (!dueDate || typeof dueDate !== 'string') return null;
  const text = dueDate.trim();
  const explicit = normalizeReminderDeadline(text);
  if (explicit)
    return explicit.kind === 'date'
      ? text
      : new Date(explicit.instant).toISOString();
  if (!meetingStartedAt) return null;
  const meeting = normalizeReminderDeadline(meetingStartedAt);
  if (!meeting) return null;
  let calendarDate = meetingStartedAt.slice(0, 10);
  if (timeZone && meeting.kind === 'timestamp') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(meeting.instant);
      const part = (type: string) =>
        parts.find((entry) => entry.type === type)?.value;
      calendarDate = `${part('year')}-${part('month')}-${part('day')}`;
    } catch {
      return null;
    }
  }
  const base = normalizeReminderDeadline(calendarDate);
  if (base?.kind !== 'date') return null;
  const lower = text.toLowerCase();
  let days: number;
  if (lower === 'today') days = 0;
  else if (lower === 'tomorrow') days = 1;
  else {
    const dayNames = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    const weekday =
      /^(?:(?:by|on) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(
        lower,
      );
    const target = weekday
      ? dayNames.indexOf(weekday[1])
      : lower === 'end of week' || lower === 'eow'
        ? 5
        : -1;
    if (target < 0) return null; // A week, locale-dependent date or vague phrase is not a deadline.
    days = (target - new Date(base.day).getUTCDay() + 7) % 7;
  }
  return new Date(base.day + days * 86_400_000).toISOString().slice(0, 10);
}
