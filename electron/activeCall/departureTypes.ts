/** Content-free protocol shared by the native monitor, main process and UI. */
export type CallSource = {
  id: string;
  bundleId: string;
  pid: number;
  name: string;
  version: string;
  input: boolean | null;
  output: boolean | null;
  audioGeneration: string;
};
export type ActivitySnapshot = {
  kind: 'activity';
  version: 1;
  epoch: string;
  sequence: number;
  healthy: boolean;
  discontinuity: boolean;
  sources: CallSource[];
  /** Only NSWorkspace termination notifications, never absence from audio enumeration. */
  terminated: string[];
};
export type DepartureProvider = 'meet' | 'zoom' | 'teams' | 'slack';
export type UiMarker = { role: string; identifier: string; token: string };
export type InspectionSnapshot = {
  kind: 'inspection';
  version: 1;
  requestId: string;
  sourceId: string;
  healthy: boolean;
  trusted: boolean;
  windows: { id: string; markers: UiMarker[] }[];
};
export type DepartureEvidence = {
  sourceId: string;
  sessionId: string;
  state: 'joined' | 'departed' | 'unknown';
  provider: DepartureProvider;
  accepted: boolean;
};
export type DeparturePhase =
  | 'untracked'
  | 'joined'
  | 'departure_suspected'
  | 'departure_confirmed'
  | 'stop_requested'
  | 'stopped';
export type DepartureSession = { meetingId: string; generation: string };
export type DepartureStopRequest = DepartureSession & {
  requestId: string;
  reason:
    | 'app_terminated'
    | 'ui_departure'
    | 'tab_closed'
    | 'user_confirmed'
    | 'calendar_quiet_timeout'
    | 'calendar_user_confirmed';
  provider: DepartureProvider | null;
  sourceId: string | null;
  appName: string | null;
};
export type DepartureStatus = DepartureSession & {
  phase: DeparturePhase;
  source: CallSource | null;
  /** Explicit user confirmation; app-wide audio alone is only a suggestion. */
  sourceConfirmed: boolean;
  candidates: CallSource[];
  unavailable: boolean;
  sessionAmbiguous: boolean;
  checkIn: boolean;
  calendarCheck: { secondsRemaining: number } | null;
  inspection: 'off' | 'unavailable' | 'awaiting_acceptance' | 'ready';
  stop: DepartureStopRequest | null;
};
export const DEPARTURE_IPC = {
  begin: 'CALL_DEPARTURE_BEGIN',
  end: 'CALL_DEPARTURE_END',
  status: 'CALL_DEPARTURE_STATUS',
  select: 'CALL_DEPARTURE_SELECT',
  keep: 'CALL_DEPARTURE_KEEP',
  endMeeting: 'CALL_DEPARTURE_END_MEETING',
  claim: 'CALL_DEPARTURE_CLAIM',
  acknowledge: 'CALL_DEPARTURE_ACK',
  preferences: 'CALL_DEPARTURE_PREFERENCES',
} as const;
