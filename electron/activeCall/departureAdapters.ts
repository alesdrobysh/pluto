import type {
  CallSource,
  DepartureEvidence,
  DepartureProvider,
  InspectionSnapshot,
  UiMarker,
} from './departureTypes';

export type AcceptedDepartureLayout = {
  provider: DepartureProvider;
  appVersion: string;
  /** Packaged acceptance artifact; never accept a renderer-provided profile. */
  acceptance: string;
  joined: UiMarker[];
  departed: UiMarker[];
};

// No fabricated acceptance: add exact versions/AX identifiers only after the
// signed-app matrix in docs/follow-ups/meeting-departure-detection.md passes.
export const ACCEPTED_DEPARTURE_LAYOUTS: readonly AcceptedDepartureLayout[] =
  [];

export const providerForBundle = (bundleId: string): DepartureProvider | null =>
  (({
    'com.google.Chrome': 'meet',
    'us.zoom.xos': 'zoom',
    'com.microsoft.teams2': 'teams',
    'com.tinyspeck.slackmacgap': 'slack',
  })[bundleId] as DepartureProvider | undefined) ?? null;

const hasMarkers = (actual: UiMarker[], required: UiMarker[]) =>
  required.length > 0 &&
  required.every((wanted) =>
    actual.some(
      (marker) =>
        marker.role === wanted.role &&
        marker.identifier === wanted.identifier &&
        marker.token === wanted.token,
    ),
  );

const joinedTokens = new Set([
  'leave_call',
  'leave_meeting',
  'leave_huddle',
  'hang_up',
]);
const departedTokens = new Set([
  'left_meeting',
  'left_call',
  'meeting_ended',
  'host_ended',
  'left_huddle',
  'huddle_ended',
]);
export const safeLayout = (layout: AcceptedDepartureLayout) =>
  layout.acceptance.length > 0 &&
  layout.appVersion !== 'unknown' &&
  layout.joined.length > 0 &&
  layout.departed.length > 0 &&
  layout.joined.every((marker) => joinedTokens.has(marker.token)) &&
  layout.departed.every((marker) => departedTokens.has(marker.token));

/** All four adapters require a positively identified, accepted UI layout. */
export function inspectDeparture(
  source: CallSource,
  snapshot: InspectionSnapshot,
  layouts: readonly AcceptedDepartureLayout[] = ACCEPTED_DEPARTURE_LAYOUTS,
): DepartureEvidence[] {
  const provider = providerForBundle(source.bundleId);
  if (
    !provider ||
    !snapshot.healthy ||
    !snapshot.trusted ||
    snapshot.sourceId !== source.id
  )
    return [];
  const layout = layouts.find(
    (item) =>
      item.provider === provider &&
      item.appVersion === source.version &&
      safeLayout(item),
  );
  return snapshot.windows.map((window) => {
    const joined = !!layout && hasMarkers(window.markers, layout.joined);
    const departed = !!layout && hasMarkers(window.markers, layout.departed);
    return {
      sourceId: source.id,
      sessionId: window.id,
      provider,
      accepted: !!layout,
      // Conflicting or incomplete layouts never establish departure.
      state: joined === departed ? 'unknown' : joined ? 'joined' : 'departed',
    };
  });
}
