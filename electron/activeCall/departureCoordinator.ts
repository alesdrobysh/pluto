import { randomUUID } from 'node:crypto';
import { providerForBundle } from './departureAdapters';
import type {
  ActivitySnapshot,
  DepartureEvidence,
  DepartureSession,
  DepartureStatus,
} from './departureTypes';

/** Main-process authority. Audio activity can suspect departure, never confirm it. */
export class DepartureCoordinator {
  readonly status: DepartureStatus;
  private epoch = '';
  private sequence = -1;
  private lastObservation = 0;
  private unhealthySince: number | null = null;
  private quietSince: number | null = null;
  private calendarEndAt: number | null = null;
  private calendarQuietSince: number | null = null;
  private calendarCheckAt: number | null = null;
  private calendarCheckSuppressed = false;
  private prompted = false;
  private joinedSession: string | null = null;
  private sessionAmbiguous = false;
  private confirmation: { sessionId: string; at: number } | null = null;
  private candidateSince = new Map<string, number>();
  private corroborateUntil = 0;
  private lastInspection = Number.NEGATIVE_INFINITY;
  private previousInput: boolean | null = null;
  private claimed = false;
  private evidenceRevision = 0;
  private diagnostics: { at: number; code: string }[] = [];

  constructor(
    session: DepartureSession,
    private now: () => number = () => performance.now(),
    private wallNow: () => number = () => Date.now(),
  ) {
    this.status = {
      ...session,
      phase: 'untracked',
      source: null,
      candidates: [],
      unavailable: false,
      sessionAmbiguous: false,
      checkIn: false,
      calendarCheck: null,
      inspection: 'off',
      stop: null,
    };
  }

  matches(session: DepartureSession) {
    return (
      session.meetingId === this.status.meetingId &&
      session.generation === this.status.generation
    );
  }
  private log(code: string) {
    this.diagnostics.push({ at: this.now(), code });
    if (this.diagnostics.length > 128) this.diagnostics.shift();
  }
  diagnosticSnapshot() {
    return this.diagnostics.map((entry) => ({ ...entry }));
  }
  revision() {
    return this.evidenceRevision;
  }
  private resetConfirmation() {
    this.confirmation = null;
    if (!this.claimed && !this.status.stop && this.status.phase !== 'stopped')
      this.status.phase = this.status.source
        ? 'departure_suspected'
        : 'untracked';
  }
  invalidate(preserveJoinedSession = false) {
    this.evidenceRevision++;
    this.resetConfirmation();
    if (!preserveJoinedSession) {
      if (this.joinedSession) {
        // An opaque window/tab identity cannot be rebound after monitoring
        // loses continuity. Keep UI auto-stop unavailable for this recording.
        this.sessionAmbiguous = true;
        this.status.sessionAmbiguous = true;
      }
      this.joinedSession = null;
    }
    this.previousInput = null;
    this.cancelCalendarCheck();
    this.calendarQuietSince = null;
    this.candidateSince.clear();
    this.unhealthySince ??= this.now();
    this.log('observation_unknown');
  }
  observe(snapshot: ActivitySnapshot) {
    const now = this.now();
    if (snapshot.epoch === this.epoch && snapshot.sequence <= this.sequence)
      return;
    const changedEpoch = !!this.epoch && snapshot.epoch !== this.epoch;
    this.epoch = snapshot.epoch;
    this.sequence = snapshot.sequence;
    this.lastObservation = now;
    // An OS termination notification for the bound application instance is
    // positive departure evidence even if an unrelated audio read failed.
    if (this.status.source && snapshot.terminated.includes(this.status.source.id)) {
      this.requestStop('app_terminated');
      return;
    }
    if (!snapshot.healthy || snapshot.discontinuity || changedEpoch) {
      const bound = this.status.source;
      const sameKnownSource =
        !snapshot.discontinuity &&
        !changedEpoch &&
        !!bound &&
        snapshot.sources.some(
          (source) =>
            source.id === bound.id &&
            source.audioGeneration === bound.audioGeneration &&
            source.input !== null &&
            source.output !== null,
        );
      // A failed read for another audio process cancels confirmation but does
      // not erase a continuously observed call window in the same helper.
      this.invalidate(sameKnownSource);
      return;
    }
    this.unhealthySince = null;
    this.status.unavailable = false;
    if (this.claimed || this.status.phase === 'stopped') return;
    const active = snapshot.sources.filter(
      (source) => source.input === true || source.output === true,
    );
    this.status.candidates = snapshot.sources.filter(
      (source) => source.input !== null && source.output !== null,
    );
    for (const key of this.candidateSince.keys())
      if (!active.some((source) => source.id === key))
        this.candidateSince.delete(key);
    for (const source of active)
      if (!this.candidateSince.has(source.id))
        this.candidateSince.set(source.id, now);
    if (
      !this.status.source &&
      active.length === 1 &&
      now - (this.candidateSince.get(active[0].id) ?? now) >= 3000
    )
      this.select(active[0].id);
    const bound = this.status.source;
    if (!bound) return;
    const current = snapshot.sources.find((source) => source.id === bound.id);
    if (!current) {
      this.invalidate();
      return;
    } // Missing audio/app enumeration isn't termination.
    if (current.audioGeneration !== bound.audioGeneration)
      this.invalidate(true);
    this.status.source = current;
    if (current.input === null || current.output === null) {
      this.invalidate();
      return;
    }
    if (this.previousInput === true && current.input === false) {
      this.corroborateUntil = now + 15_000;
      this.lastInspection = Number.NEGATIVE_INFINITY;
      this.status.phase = 'departure_suspected';
      this.log('microphone_released');
    }
    if (this.previousInput === false && current.input === true)
      this.resetConfirmation();
    this.previousInput = current.input;
    if (current.input === false && current.output === false) {
      this.calendarQuietSince ??= now;
    } else {
      this.calendarQuietSince = null;
      this.cancelCalendarCheck();
    }
    if (current.input === true) {
      this.status.phase = this.status.stop ? this.status.phase : 'joined';
      this.quietSince = null;
      this.status.checkIn = false;
    } else this.quietSince ??= now;
    this.tick();
  }
  select(sourceId: string) {
    if (this.status.source || this.claimed) return false;
    const source = this.status.candidates.find(
      (candidate) => candidate.id === sourceId,
    );
    if (!source || source.input === null || source.output === null)
      return false;
    this.status.source = source;
    this.evidenceRevision++;
    this.status.phase = 'joined';
    this.previousInput = source.input;
    this.log('source_bound');
    return true;
  }
  /** The inspection service calls this only for a fresh request in this generation. */
  inspect(evidence: DepartureEvidence[]) {
    if (
      this.claimed ||
      this.status.stop ||
      !this.status.source ||
      this.now() - this.lastObservation > 3000
    )
      return;
    const relevant = evidence.filter(
      (item) => item.accepted && item.sourceId === this.status.source?.id,
    );
    const joined = relevant.filter((item) => item.state === 'joined');
    if (joined.length) {
      this.resetConfirmation();
      if (
        joined.length !== 1 ||
        (this.joinedSession && joined[0].sessionId !== this.joinedSession)
      ) {
        this.sessionAmbiguous = true;
        this.status.sessionAmbiguous = true;
        return;
      }
      if (!this.sessionAmbiguous) this.joinedSession = joined[0].sessionId;
      this.status.phase = 'joined';
      this.status.checkIn = false;
      this.quietSince = null;
      return;
    }
    // Exactly one previously joined session; unrelated/multiple windows are inconclusive.
    if (
      relevant.length !== 1 ||
      relevant[0].state !== 'departed' ||
      relevant[0].sessionId !== this.joinedSession ||
      this.sessionAmbiguous
    ) {
      this.resetConfirmation();
      return;
    }
    const current = relevant[0];
    if (!this.confirmation)
      this.confirmation = { sessionId: current.sessionId, at: this.now() };
    else if (this.now() - this.confirmation.at >= 1000)
      this.requestStop('ui_departure');
  }
  inspectionDue() {
    if (!this.status.source || this.claimed) return false;
    const interval =
      this.now() < this.corroborateUntil || this.confirmation ? 1000 : 5000;
    if (this.now() - this.lastInspection < interval) return false;
    this.lastInspection = this.now();
    return true;
  }
  tick() {
    if (this.now() - this.lastObservation > 3000) this.invalidate();
    if (
      this.corroborateUntil > 0 &&
      this.now() >= this.corroborateUntil &&
      this.unhealthySince === null &&
      this.now() - this.lastObservation <= 3000 &&
      !this.confirmation &&
      !this.status.stop &&
      this.status.phase === 'departure_suspected'
    ) {
      this.corroborateUntil = 0;
      this.status.phase = 'joined';
    }
    this.status.unavailable =
      this.unhealthySince !== null &&
      this.now() - this.unhealthySince >= 30_000;
    if (
      !this.calendarCheckSuppressed &&
      this.calendarEndAt !== null &&
      this.wallNow() >= this.calendarEndAt + 120_000 &&
      this.status.source &&
      !this.joinedSession &&
      this.calendarQuietSince !== null &&
      this.now() - this.calendarQuietSince >= 120_000 &&
      this.now() - this.lastObservation <= 3000 &&
      !this.status.stop &&
      !this.status.sessionAmbiguous
    ) {
      this.calendarCheckAt ??= this.now();
      const remaining = 20_000 - (this.now() - this.calendarCheckAt);
      if (remaining <= 0) {
        this.status.calendarCheck = null;
        this.requestStop('calendar_quiet_timeout');
      } else {
        this.status.calendarCheck = {
          secondsRemaining: Math.ceil(remaining / 1000),
        };
        this.status.checkIn = false;
      }
    }
    if (
      !this.prompted &&
      !this.status.calendarCheck &&
      this.quietSince !== null &&
      this.now() - this.quietSince >= 120_000
    ) {
      this.prompted = true;
      this.status.checkIn = true;
    }
  }
  keepRecording() {
    if (this.claimed) return;
    this.resetConfirmation();
    this.status.checkIn = false;
    this.calendarCheckSuppressed = true;
    this.cancelCalendarCheck();
    this.prompted = true;
    this.log('user_kept_recording');
  }
  requestStop(
    reason: 'app_terminated' | 'ui_departure' | 'tab_closed' | 'user_confirmed' | 'calendar_quiet_timeout' | 'calendar_user_confirmed',
  ) {
    if (this.claimed || this.status.stop || this.status.phase === 'stopped')
      return;
    this.status.phase = 'departure_confirmed';
    this.status.calendarCheck = null;
    this.status.stop = {
      meetingId: this.status.meetingId,
      generation: this.status.generation,
      requestId: randomUUID(),
      reason,
      provider: this.status.source
        ? providerForBundle(this.status.source.bundleId)
        : null,
      sourceId: this.status.source?.id ?? null,
      appName: this.status.source?.name ?? null,
    };
    this.log(reason);
  }

  setCalendarEnd(endAt: number | null) {
    if (endAt === this.calendarEndAt) return;
    this.calendarEndAt = endAt;
    this.cancelCalendarCheck();
    this.calendarQuietSince = null;
  }

  private cancelCalendarCheck() {
    this.calendarCheckAt = null;
    this.status.calendarCheck = null;
  }
  claim(requestId: string) {
    if (this.claimed || this.status.stop?.requestId !== requestId) return false;
    if (
      this.status.stop.reason !== 'user_confirmed' &&
      this.status.stop.reason !== 'calendar_user_confirmed' &&
      this.now() - this.lastObservation > 3000
    ) {
      this.invalidate();
      return false;
    }
    this.claimed = true;
    this.status.phase = 'stop_requested';
    return true;
  }
  acknowledge(requestId: string, released: boolean) {
    if (!this.claimed || this.status.stop?.requestId !== requestId)
      return false;
    if (released) {
      this.status.phase = 'stopped';
      this.log('capture_released');
    } else {
      // Keep confirmed request retryable; never announce successful release.
      this.claimed = false;
      this.status.phase = 'departure_confirmed';
      this.log('capture_release_failed');
    }
    return true;
  }
}
