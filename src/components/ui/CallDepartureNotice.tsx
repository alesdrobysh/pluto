import type { DepartureStatus } from '../../../electron/activeCall/departureTypes';

export function CallDepartureNotice({
  status,
  onSelect,
  onKeep,
  onEnd,
}: {
  status: DepartureStatus;
  onSelect: (id: string) => void;
  onKeep: () => void;
  onEnd: () => void;
}) {
  if (status.phase === 'stopped') return null;
  const activeCandidates = status.candidates.filter(
    (candidate) => candidate.input === true || candidate.output === true,
  );
  const selectable = !status.source && activeCandidates.length > 1;
  const message = status.sessionAmbiguous
    ? 'Call identity is uncertain. Automatic stopping is unavailable; recording continues.'
    : status.unavailable
      ? 'Automatic stopping unavailable. Recording continues.'
      : status.checkIn
        ? 'Still in the meeting? Recording continues until you end it.'
        : selectable
          ? 'Which call are you recording?'
          : null;
  if (!message) return null;
  return (
    <aside
      role="status"
      aria-label="Meeting detection"
      className="fixed bottom-6 right-6 z-[1900] max-w-sm rounded-xl border border-pro-border bg-pro-surface p-4 text-pro-text-main shadow-lg"
    >
      <p className="text-sm mb-3">{message}</p>
      {selectable && (
        <div className="flex flex-wrap gap-2 mb-3">
          {activeCandidates.map((source) => (
            <button
              type="button"
              key={source.id}
              className="rounded border border-pro-border px-3 py-2 text-sm"
              onClick={() => onSelect(source.id)}
            >
              {source.name}
            </button>
          ))}
        </div>
      )}
      {(status.checkIn || status.unavailable || status.sessionAmbiguous) && (
        <div className="flex gap-3 text-sm">
          {status.checkIn && (
            <button
              type="button"
              className="rounded border border-pro-border px-3 py-2"
              onClick={onKeep}
            >
              Keep recording
            </button>
          )}
          <button
            type="button"
            className="rounded bg-pro-accent px-3 py-2 text-white"
            onClick={onEnd}
          >
            End meeting
          </button>
        </div>
      )}
    </aside>
  );
}
