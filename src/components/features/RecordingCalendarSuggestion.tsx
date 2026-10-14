import { Sparkles, X } from 'lucide-react';
import type { CalendarEvent } from '../../../electron/calendar/types';

export interface RecordingCalendarSuggestionProps {
  events: CalendarEvent[];
  selectedOccurrenceKey: string;
  busy: boolean;
  error: string | null;
  onSelect: (occurrenceKey: string) => void;
  onAdd: () => void;
  onDismiss: () => void;
}

const optionLabel = (event: CalendarEvent) => {
  const time = new Date(event.start).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${event.title || 'Untitled meeting'} · ${time}`;
};

export const RecordingCalendarSuggestion = ({
  events,
  selectedOccurrenceKey,
  busy,
  error,
  onSelect,
  onAdd,
  onDismiss,
}: RecordingCalendarSuggestionProps) => (
  <section
    aria-label="Suggested calendar meeting"
    className="mb-6 shrink-0 rounded-xl border border-pro-accent/25 bg-pro-accent/10 p-3 text-pro-text-main"
  >
    <div className="flex items-center gap-2">
      <Sparkles aria-hidden="true" size={16} className="shrink-0 text-pro-accent" />
      <span className="min-w-0 flex-1 text-sm font-medium text-pro-accent">
        Suggested meeting
      </span>
      <button
        type="button"
        onClick={onDismiss}
        disabled={busy}
        aria-label="Dismiss suggested meeting"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-pro-text-muted transition-colors hover:bg-pro-hover hover:text-pro-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pro-accent disabled:opacity-40"
      >
        <X aria-hidden="true" size={17} />
      </button>
    </div>
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <label className="min-w-0 flex-1">
        <span className="sr-only">Overlapping calendar invite</span>
        <select
          aria-label="Overlapping calendar invite"
          value={selectedOccurrenceKey}
          onChange={(event) => onSelect(event.target.value)}
          disabled={busy}
          className="h-9 w-full min-w-0 rounded-lg border border-pro-border bg-pro-surface px-3 text-sm text-pro-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pro-accent"
        >
          {events.length > 1 && <option value="">Choose a meeting</option>}
          {events.map((event) => (
            <option key={event.occurrenceKey} value={event.occurrenceKey}>
              {optionLabel(event)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={onAdd}
        disabled={!selectedOccurrenceKey || busy}
        aria-label="Add selected calendar invite to this recording"
        className="h-9 shrink-0 rounded-lg bg-pro-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-pro-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pro-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Adding…' : 'Add'}
      </button>
    </div>
    {error && (
      <p role="alert" className="w-full px-2 text-xs text-pro-warning">
        {error}
      </p>
    )}
  </section>
);
