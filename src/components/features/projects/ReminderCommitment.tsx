import { CalendarDays, Check, ChevronRight, Sparkles, X } from 'lucide-react';
import type { Entity } from '../../../api/knowledgeGraph';

const iconButton =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-pro-text-muted hover:bg-pro-surface hover:text-pro-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pro-accent/40 disabled:opacity-50';

/** The focused task opened from a reminder, using the notes' checkbox language. */
export function ReminderCommitment({
  task,
  loading,
  loadError,
  mutationError,
  busy,
  onRetry,
  onToggle,
  onDueDateChange,
  onDismiss,
}: {
  task?: Entity;
  loading: boolean;
  loadError: boolean;
  mutationError: string;
  busy: boolean;
  onRetry: () => void;
  onToggle: (task: Entity) => void;
  onDueDateChange: (task: Entity, date: string) => void;
  onDismiss?: () => void;
}) {
  const completed = task?.status === 'completed';
  const dateValue = task?.due_date?.slice(0, 10) ?? '';
  const date = dateValue ? new Date(`${dateValue}T00:00:00`) : null;
  const dueLabel =
    date && !Number.isNaN(date.getTime())
      ? `Due ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)}`
      : 'Set due date';

  return (
    <section
      aria-label="Reminder commitment"
      className="relative rounded-xl border border-pro-border bg-pro-accent/[0.025] px-5 py-4"
    >
      <details open className="group/commitment">
        <summary className="flex min-h-7 w-fit cursor-pointer list-none items-center gap-3 rounded pr-10 text-[13px] font-medium text-pro-text-main/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pro-accent/40 [&::-webkit-details-marker]:hidden">
          <span className="flex w-5 shrink-0 justify-center">
            <Sparkles
              aria-hidden="true"
              strokeWidth={1.5}
              className="h-3.5 w-3.5 text-pro-accent"
            />
          </span>
          Commitment
          <ChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 text-pro-text-muted group-open/commitment:rotate-90"
          />
        </summary>
        <div className="grid gap-1 pt-2">
          {loading ? (
            <output className="block pl-8 text-sm text-pro-text-muted">
              Loading commitment…
            </output>
          ) : loadError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 pl-8 text-sm text-pro-urgent"
            >
              We couldn’t load this commitment.
              <button
                type="button"
                onClick={onRetry}
                className="rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-pro-accent/40"
              >
                Retry
              </button>
            </div>
          ) : task ? (
            <>
              <label className="flex cursor-pointer items-start gap-3">
                <span className="relative flex h-6 w-5 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={completed}
                    disabled={busy}
                    onChange={() => onToggle(task)}
                    aria-label={completed ? 'Mark incomplete' : 'Mark complete'}
                    className="peer h-[18px] w-[18px] cursor-pointer appearance-none rounded-full border border-pro-text-muted checked:border-pro-accent checked:bg-pro-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pro-accent/40 focus-visible:ring-offset-2 disabled:opacity-50"
                  />
                  <Check
                    aria-hidden="true"
                    className="pointer-events-none absolute h-3 w-3 text-white opacity-0 peer-checked:opacity-100"
                  />
                </span>
                <span
                  className={`min-w-0 max-w-[65ch] flex-1 break-words text-[15px] leading-6 ${completed ? 'text-pro-text-muted line-through' : 'text-pro-text-main'}`}
                >
                  {task.name}
                </span>
              </label>
              {!completed && (
                <div className="flex flex-wrap items-center pl-8">
                  <label className="relative -ml-1 inline-flex min-h-6 cursor-pointer items-center gap-1.5 rounded-md px-1 text-xs text-pro-text-main/75 hover:bg-pro-surface focus-within:ring-2 focus-within:ring-pro-accent/40">
                    <CalendarDays
                      aria-hidden="true"
                      strokeWidth={1.5}
                      className="h-3 w-3"
                    />
                    <span>{dueLabel}</span>
                    <input
                      type="date"
                      aria-label={`Due date for ${task.name}`}
                      value={dateValue}
                      disabled={busy}
                      onClick={(event) => event.currentTarget.showPicker?.()}
                      onChange={(event) =>
                        onDueDateChange(task, event.target.value)
                      }
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
                    />
                  </label>
                </div>
              )}
            </>
          ) : (
            <p className="pl-8 text-sm text-pro-text-muted">
              This commitment is no longer available.
            </p>
          )}
          {mutationError && (
            <p role="alert" className="mt-1 pl-8 text-sm text-pro-urgent">
              {mutationError}
            </p>
          )}
        </div>
      </details>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss reminder"
          title="Dismiss reminder"
          onClick={onDismiss}
          className={`${iconButton} absolute right-4 top-4`}
        >
          <X aria-hidden="true" strokeWidth={1.5} className="h-3 w-3" />
        </button>
      )}
    </section>
  );
}
