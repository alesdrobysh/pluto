import { describe, expect, it } from 'vitest';
import { DepartureCoordinator } from '../../electron/activeCall/departureCoordinator';
import type {
  ActivitySnapshot,
  CallSource,
  DepartureEvidence,
} from '../../electron/activeCall/departureTypes';

const source = (
  id = 'zoom:100:launch',
  input: boolean | null = true,
  output: boolean | null = true,
): CallSource => ({
  id,
  bundleId: 'us.zoom.xos',
  pid: 100,
  name: 'Zoom',
  version: '1',
  input,
  output,
  audioGeneration: 'audio-1',
});
const evidence = (
  state: DepartureEvidence['state'],
  sessionId = 'window-1',
): DepartureEvidence => ({
  state,
  sessionId,
  sourceId: 'zoom:100:launch',
  provider: 'zoom',
  accepted: true,
});

function rig() {
  let time = 0;
  let sequence = 0;
  const coordinator = new DepartureCoordinator(
    { meetingId: 'meeting-1', generation: 'generation-1' },
    () => time,
    () => time,
  );
  const advance = (ms: number) => {
    time += ms;
    coordinator.tick();
  };
  const observe = (
    sources: CallSource[],
    extras: Partial<ActivitySnapshot> = {},
  ) => {
    const snapshot: ActivitySnapshot = {
      kind: 'activity',
      version: 1,
      epoch: 'helper-1',
      sequence: ++sequence,
      healthy: true,
      discontinuity: false,
      sources,
      terminated: [],
      ...extras,
    };
    coordinator.observe(snapshot);
  };
  observe([source()]);
  advance(3_000);
  observe([source()]);
  return { coordinator, advance, observe };
}

describe('confirmed departure policy', () => {
  it('warns after calendar end and sustained quiet, then stops after twenty cancellable seconds', () => {
    const { coordinator, advance, observe } = rig();
    coordinator.setCalendarEnd(5_000);
    observe([source(undefined, false, false)]);
    for (let second = 0; second < 122; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.calendarCheck?.secondsRemaining).toBe(20);
    expect(coordinator.status.stop).toBeNull();
    for (let second = 0; second < 19; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.stop).toBeNull();
    advance(1_000);
    observe([source(undefined, false, false)]);
    expect(coordinator.status.stop?.reason).toBe('calendar_quiet_timeout');
  });

  it('cancels the calendar warning on resumed audio or Keep recording', () => {
    const { coordinator, advance, observe } = rig();
    coordinator.setCalendarEnd(5_000);
    observe([source(undefined, false, false)]);
    for (let second = 0; second < 122; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.calendarCheck).not.toBeNull();
    observe([source(undefined, false, true)]);
    expect(coordinator.status.calendarCheck).toBeNull();
    for (let second = 0; second < 121; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.calendarCheck).not.toBeNull();
    coordinator.keepRecording();
    for (let second = 0; second < 60; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.stop).toBeNull();
    expect(coordinator.status.calendarCheck).toBeNull();
  });

  it('never starts a calendar warning without a linked end or after a failed observation', () => {
    const { coordinator, advance, observe } = rig();
    observe([source(undefined, false, false)]);
    for (let second = 0; second < 150; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.calendarCheck).toBeNull();
    coordinator.setCalendarEnd(5_000);
    observe([source(undefined, false, false)]);
    advance(121_000);
    observe([source(undefined, false, false), source('other', null, null)], { healthy: false });
    expect(coordinator.status.calendarCheck).toBeNull();
    expect(coordinator.status.stop).toBeNull();
  });

  it('does not use calendar quiet time to override a verified joined session', () => {
    const { coordinator, advance, observe } = rig();
    coordinator.setCalendarEnd(5_000);
    coordinator.inspect([evidence('joined')]);
    observe([source(undefined, false, false)]);
    for (let second = 0; second < 160; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.calendarCheck).toBeNull();
    expect(coordinator.status.stop).toBeNull();
  });

  it('keeps a muted, silent joined call recording for thirty minutes despite both audio streams releasing', () => {
    const { coordinator, advance, observe } = rig();
    coordinator.inspect([evidence('joined')]);
    observe([source(undefined, false, false)]);
    for (let second = 0; second < 30 * 60; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.stop).toBeNull();
    expect(coordinator.status.unavailable).toBe(false);
    expect(coordinator.status.sessionAmbiguous).toBe(false);
    expect(coordinator.status.checkIn).toBe(true);
    coordinator.inspect([evidence('joined')]);
    expect(coordinator.status.stop).toBeNull();
  });

  it('returns to ordinary monitoring after the fifteen-second corroboration window', () => {
    const { coordinator, advance, observe } = rig();
    coordinator.inspect([evidence('joined')]);
    observe([source(undefined, false, false)]);
    expect(coordinator.status.phase).toBe('departure_suspected');
    for (let second = 0; second < 16; second++) {
      advance(1_000);
      observe([source(undefined, false, false)]);
    }
    expect(coordinator.status.phase).toBe('joined');
    expect(coordinator.status.stop).toBeNull();
  });

  it('requires two positive observations for the same previously joined session', () => {
    const { coordinator, advance } = rig();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
    advance(1_001);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop?.reason).toBe('ui_departure');
    expect(coordinator.claim(coordinator.status.stop!.requestId)).toBe(true);
    expect(coordinator.claim(coordinator.status.stop!.requestId)).toBe(false);
    expect(
      coordinator.acknowledge(coordinator.status.stop!.requestId, true),
    ).toBe(true);
    expect(coordinator.status.phase).toBe('stopped');
  });

  it('resets a single false departure on joined, unknown, conflicting, or stale evidence', () => {
    const { coordinator, advance } = rig();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed')]);
    advance(1_001);
    coordinator.inspect([evidence('unknown')]);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
    advance(1_001);
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed')]);
    advance(1_001);
    coordinator.inspect([evidence('joined'), evidence('departed', 'window-2')]);
    expect(coordinator.status.stop).toBeNull();
    coordinator.inspect([evidence('departed')]);
    advance(3_001);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
  });

  it('cannot transfer departure evidence between windows or calls', () => {
    const { coordinator, advance } = rig();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed', 'window-2')]);
    advance(1_001);
    coordinator.inspect([evidence('departed', 'window-2')]);
    expect(coordinator.status.stop).toBeNull();
    coordinator.inspect([{ ...evidence('departed'), sourceId: 'other-app' }]);
    expect(coordinator.status.stop).toBeNull();
    expect(
      coordinator.matches({ meetingId: 'meeting-1', generation: 'stale' }),
    ).toBe(false);
  });

  it('requires source selection when a second muted call is still producing output', () => {
    let now = 0;
    const coordinator = new DepartureCoordinator(
      { meetingId: 'meeting-1', generation: 'generation-1' },
      () => now,
    );
    const muted = {
      ...source('teams:200:launch', false, true),
      bundleId: 'com.microsoft.teams2',
      name: 'Teams',
      pid: 200,
    };
    coordinator.observe({
      kind: 'activity',
      version: 1,
      epoch: 'helper-1',
      sequence: 1,
      healthy: true,
      discontinuity: false,
      sources: [source(), muted],
      terminated: [],
    });
    now = 4_000;
    coordinator.observe({
      kind: 'activity',
      version: 1,
      epoch: 'helper-1',
      sequence: 2,
      healthy: true,
      discontinuity: false,
      sources: [source(), muted],
      terminated: [],
    });
    expect(coordinator.status.source).toBeNull();
    expect(coordinator.status.candidates).toHaveLength(2);
    expect(coordinator.select(muted.id)).toBe(true);
    coordinator.observe({
      kind: 'activity',
      version: 1,
      epoch: 'helper-1',
      sequence: 3,
      healthy: true,
      discontinuity: false,
      sources: [muted],
      terminated: [source().id],
    });
    expect(coordinator.status.stop).toBeNull();
  });

  it('binds the sole active browser app even when an idle meeting app is open', () => {
    let now = 0;
    const coordinator = new DepartureCoordinator(
      { meetingId: 'meeting-1', generation: 'generation-1' },
      () => now,
    );
    const chrome = {
      ...source('chrome:300:launch'),
      bundleId: 'com.google.Chrome',
      name: 'Google Chrome',
      pid: 300,
    };
    coordinator.observe({
      kind: 'activity',
      version: 1,
      epoch: 'helper-1',
      sequence: 1,
      healthy: true,
      discontinuity: false,
      sources: [chrome, { ...source('zoom:400:launch', false, false), pid: 400 }],
      terminated: [],
    });
    now = 4_000;
    coordinator.observe({
      kind: 'activity',
      version: 1,
      epoch: 'helper-1',
      sequence: 2,
      healthy: true,
      discontinuity: false,
      sources: [chrome, { ...source('zoom:400:launch', false, false), pid: 400 }],
      terminated: [],
    });
    expect(coordinator.status.source?.id).toBe(chrome.id);
  });

  it('never silently transfers a joined session to another window', () => {
    const { coordinator, advance } = rig();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('joined', 'window-2')]);
    expect(coordinator.status.sessionAmbiguous).toBe(true);
    coordinator.inspect([evidence('departed', 'window-2')]);
    advance(1_001);
    coordinator.inspect([evidence('departed', 'window-2')]);
    expect(coordinator.status.stop).toBeNull();
    coordinator.inspect([evidence('departed')]);
    advance(1_001);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
  });

  it('invalidates confirmation for device changes and helper restarts, and keeps release failures retryable', () => {
    const { coordinator, advance, observe } = rig();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed')]);
    observe([{ ...source(), audioGeneration: 'audio-2' }]);
    advance(1_001);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed')]);
    observe([source()], { epoch: 'helper-2' });
    advance(1_001);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
    expect(coordinator.status.sessionAmbiguous).toBe(true);
    coordinator.inspect([evidence('joined', 'window-2')]);
    coordinator.inspect([evidence('departed', 'window-2')]);
    advance(1_001);
    coordinator.inspect([evidence('departed', 'window-2')]);
    expect(coordinator.status.stop).toBeNull();
    coordinator.requestStop('user_confirmed');
    const requestId = coordinator.status.stop!.requestId;
    expect(coordinator.claim(requestId)).toBe(true);
    expect(coordinator.acknowledge(requestId, false)).toBe(true);
    expect(coordinator.status.phase).toBe('departure_confirmed');
    expect(coordinator.claim(requestId)).toBe(true);
  });

  it('accepts only the exact bound application termination event', () => {
    const { coordinator, observe } = rig();
    observe([source()], { terminated: ['other-app'] });
    expect(coordinator.status.stop).toBeNull();
    observe([source()], { terminated: ['zoom:100:launch'] });
    expect(coordinator.status.stop?.reason).toBe('app_terminated');
  });

  it('retains exact application termination despite an unrelated failed audio read', () => {
    const { coordinator, observe } = rig();
    coordinator.inspect([evidence('joined')]);
    observe([source(undefined, null, null)], {
      healthy: false,
      terminated: ['zoom:100:launch'],
    });
    expect(coordinator.status.stop?.reason).toBe('app_terminated');
  });

  it('treats failed audio reads as unknown rather than inactive departure', () => {
    const { coordinator, observe, advance } = rig();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed')]);
    observe([source(undefined, null, null)]);
    advance(1_001);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
    expect(coordinator.status.sessionAmbiguous).toBe(true);
  });

  it('recovers joined-session identity after an unrelated transient audio read failure', () => {
    const { coordinator, observe, advance } = rig();
    coordinator.inspect([evidence('joined')]);
    coordinator.inspect([evidence('departed')]);
    observe([source()], { healthy: false });
    expect(coordinator.status.stop).toBeNull();
    expect(coordinator.status.sessionAmbiguous).toBe(false);
    observe([source()]);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop).toBeNull();
    advance(1_001);
    coordinator.inspect([evidence('departed')]);
    expect(coordinator.status.stop?.reason).toBe('ui_departure');
  });
});
