import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  monitorStarts: vi.fn(),
  monitorStops: vi.fn(),
  activity: null as null | ((snapshot: unknown) => void),
  inspection: null as null | (() => unknown),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../electron/activeCall/nativeCallMonitor', () => ({
  NativeCallMonitor: class {
    constructor(_executable: string, activity: (snapshot: unknown) => void) {
      mocks.activity = activity;
    }
    start() {
      mocks.monitorStarts();
    }
    stop() {
      mocks.monitorStops();
    }
    inspect() {
      return Promise.resolve(mocks.inspection?.() ?? null);
    }
  },
}));

import { registerDepartureService } from '../../electron/activeCall/departureService';
import {
  type DepartureSession,
  type DepartureStatus,
  DEPARTURE_IPC as IPC,
} from '../../electron/activeCall/departureTypes';

const owner = {
  id: 17,
  isDestroyed: () => false,
  send: vi.fn(),
  once: vi.fn(),
};
const event = { sender: owner };
const call = <T>(channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)?.(event, ...args) as T;

afterEach(() => {
  vi.useRealTimers();
  mocks.handlers.clear();
  mocks.activity = null;
  mocks.inspection = null;
  vi.clearAllMocks();
});

describe('departure IPC authority', () => {
  it('rejects stale generations and duplicate claims, and retries failed resource release', () => {
    const settings = new Map<string, string>();
    const requireRecordingOwner = vi.fn();
    const requireCaptureStartOwner = vi.fn();
    const service = registerDepartureService({
      executable: () => '/private/tmp/audiocap',
      getSetting: (key) => settings.get(key) ?? null,
      setSetting: (key, value) => settings.set(key, value),
      requireRecordingOwner,
      requireCaptureStartOwner,
      log: vi.fn(),
    });
    try {
      const first = call<DepartureStatus>(IPC.begin, 'meeting-1');
      expect(first.generation).toBeTruthy();
      expect(requireCaptureStartOwner).toHaveBeenCalledWith(
        'meeting-1',
        owner.id,
      );
      call(IPC.endMeeting, first);
      const status = owner.send.mock.lastCall?.[1] as DepartureStatus;
      const requestId = status.stop?.requestId;
      expect(requestId).toBeTruthy();
      const stale: DepartureSession = {
        meetingId: 'meeting-1',
        generation: 'older-generation',
      };
      expect(call<boolean>(IPC.claim, stale, requestId)).toBe(false);
      expect(call<boolean>(IPC.claim, first, requestId)).toBe(true);
      expect(call<boolean>(IPC.claim, first, requestId)).toBe(false);
      expect(call<boolean>(IPC.acknowledge, first, requestId, false)).toBe(
        true,
      );
      expect(call<boolean>(IPC.claim, first, requestId)).toBe(true);
      expect(call<boolean>(IPC.acknowledge, first, requestId, true)).toBe(true);
      expect(requireRecordingOwner).toHaveBeenCalledTimes(3);
      expect(mocks.monitorStops).toHaveBeenCalled();
    } finally {
      service.stop();
    }
  });

  it('ignores an old recording cleanup after a new recording begins', () => {
    const service = registerDepartureService({
      executable: () => '/private/tmp/audiocap',
      getSetting: () => null,
      setSetting: () => undefined,
      requireRecordingOwner: () => undefined,
      requireCaptureStartOwner: () => undefined,
      log: vi.fn(),
    });
    try {
      const first = call<DepartureStatus>(IPC.begin, 'meeting-1');
      const second = call<DepartureStatus>(IPC.begin, 'meeting-2');
      expect(second.generation).not.toBe(first.generation);
      const stoppedAfterReplacement = mocks.monitorStops.mock.calls.length;
      call(IPC.end, first);
      expect(mocks.monitorStops).toHaveBeenCalledTimes(stoppedAfterReplacement);
      call(IPC.endMeeting, first);
      expect(call<boolean>(IPC.claim, first, 'old-request')).toBe(false);
      const active = call<DepartureStatus>(IPC.begin, 'meeting-2');
      expect(active.generation).toBe(second.generation);
      call(IPC.end, second);
      expect(mocks.monitorStops).toHaveBeenCalledTimes(
        stoppedAfterReplacement + 1,
      );
    } finally {
      service.stop();
    }
  });

  it('keeps a previously active Meet tab through a muted break and stops only after exact closure', async () => {
    vi.useFakeTimers();
    const settings = new Map([
      ['browser_call_detection_enabled', 'true'],
      ['call_departure_accessibility_enabled', 'false'],
    ]);
    const key = 'meeting-key';
    let tabs = [{ id: 'tab-1', meetingKey: key }];
    const service = registerDepartureService({
      executable: () => '/private/tmp/audiocap',
      getSetting: (name) => settings.get(name) ?? null,
      setSetting: (name, value) => settings.set(name, value),
      requireRecordingOwner: () => undefined,
      requireCaptureStartOwner: () => undefined,
      log: vi.fn(),
      inspectBrowserTabs: async () => ({ healthy: true, tabs }),
      chromeTabClosureAccepted: () => true,
    });
    try {
      const session = call<DepartureStatus>(IPC.begin, 'meeting-chrome');
      const source = {
        id: 'com.google.Chrome:100:launch',
        bundleId: 'com.google.Chrome',
        pid: 100,
        name: 'Google Chrome',
        version: '155',
        input: true,
        output: true,
        audioGeneration: 'audio-1',
      };
      for (let sequence = 1; sequence <= 13; sequence++) {
        if (sequence === 7) {
          source.input = false;
          source.output = false;
        }
        mocks.activity?.({
          kind: 'activity',
          version: 1,
          epoch: 'helper-1',
          sequence,
          healthy: true,
          discontinuity: false,
          sources: [source],
          terminated: [],
        });
        await vi.advanceTimersByTimeAsync(1_000);
        if (sequence === 9)
          expect(
            (owner.send.mock.lastCall?.[1] as DepartureStatus).stop,
          ).toBeNull();
        if (sequence === 10) tabs = [];
      }
      const status = owner.send.mock.lastCall?.[1] as DepartureStatus;
      expect(status.source?.id).toBe(source.id);
      expect(status.stop?.reason).toBe('tab_closed');
      expect(call<boolean>(IPC.claim, session, status.stop?.requestId)).toBe(
        true,
      );
    } finally {
      service.stop();
    }
  });

  it('does not infer a joined Meet tab from an inactive Chrome source', async () => {
    vi.useFakeTimers();
    let tabs = [{ id: 'tab-1', meetingKey: 'meeting-key' }];
    const service = registerDepartureService({
      executable: () => '/private/tmp/audiocap',
      getSetting: (name) =>
        name === 'browser_call_detection_enabled' ? 'true' : null,
      setSetting: () => undefined,
      requireRecordingOwner: () => undefined,
      requireCaptureStartOwner: () => undefined,
      log: vi.fn(),
      inspectBrowserTabs: async () => ({ healthy: true, tabs }),
    });
    try {
      call<DepartureStatus>(IPC.begin, 'meeting-inactive');
      for (let sequence = 1; sequence <= 9; sequence++) {
        mocks.activity?.({
          kind: 'activity',
          version: 1,
          epoch: 'helper-1',
          sequence,
          healthy: true,
          discontinuity: false,
          sources: [
            {
              id: 'com.google.Chrome:100:launch',
              bundleId: 'com.google.Chrome',
              pid: 100,
              name: 'Google Chrome',
              version: '155',
              input: false,
              output: false,
              audioGeneration: 'audio-1',
            },
          ],
          terminated: [],
        });
        await vi.advanceTimersByTimeAsync(1_000);
        if (sequence === 5) tabs = [];
      }
      const status = owner.send.mock.lastCall?.[1] as DepartureStatus;
      expect(status.source).toBeNull();
      expect(status.stop).toBeNull();
    } finally {
      service.stop();
    }
  });

  it('does not stop for a closed Meet tab when tab-specific acceptance is absent', async () => {
    vi.useFakeTimers();
    const inspectBrowserTabs = vi.fn(async () => ({ healthy: true, tabs: [] }));
    const service = registerDepartureService({
      executable: () => '/private/tmp/audiocap',
      getSetting: (name) =>
        name === 'browser_call_detection_enabled' ? 'true' : null,
      setSetting: () => undefined,
      requireRecordingOwner: () => undefined,
      requireCaptureStartOwner: () => undefined,
      log: vi.fn(),
      inspectBrowserTabs,
    });
    try {
      call<DepartureStatus>(IPC.begin, 'meeting-unverified-tab');
      for (let sequence = 1; sequence <= 8; sequence++) {
        mocks.activity?.({
          kind: 'activity',
          version: 1,
          epoch: 'helper-1',
          sequence,
          healthy: true,
          discontinuity: false,
          sources: [
            {
              id: 'com.google.Chrome:100:launch',
              bundleId: 'com.google.Chrome',
              pid: 100,
              name: 'Google Chrome',
              version: '155',
              input: true,
              output: true,
              audioGeneration: 'audio-1',
            },
          ],
          terminated: [],
        });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(inspectBrowserTabs).not.toHaveBeenCalled();
      expect(
        (owner.send.mock.lastCall?.[1] as DepartureStatus).stop,
      ).toBeNull();
    } finally {
      service.stop();
    }
  });

  it('routes a linked calendar quiet timeout through confirmed release', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    const onCalendarCheck = vi.fn(() => true);
    const service = registerDepartureService({
      executable: () => '/private/tmp/audiocap',
      getSetting: () => null,
      setSetting: () => undefined,
      requireRecordingOwner: () => undefined,
      requireCaptureStartOwner: () => undefined,
      log: vi.fn(),
      getCalendarEvent: () => ({
        start: '2026-10-15T11:00:00.000Z',
        end: '2026-10-15T12:00:05.000Z',
        isAllDay: false,
        isCancelled: false,
      }),
      onCalendarCheck,
    });
    try {
      const session = call<DepartureStatus>(IPC.begin, 'calendar-meeting');
      const source = {
        id: 'us.zoom.xos:100:launch',
        bundleId: 'us.zoom.xos',
        pid: 100,
        name: 'Zoom',
        version: '1',
        input: true,
        output: true,
        audioGeneration: 'audio-1',
      };
      for (let second = 1; second <= 148; second++) {
        if (second === 5) {
          source.input = false;
          source.output = false;
        }
        mocks.activity?.({
          kind: 'activity',
          version: 1,
          epoch: 'helper-1',
          sequence: second,
          healthy: true,
          discontinuity: false,
          sources: [source],
          terminated: [],
        });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const status = owner.send.mock.lastCall?.[1] as DepartureStatus;
      expect(onCalendarCheck).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: 'calendar-meeting' }),
        true,
      );
      expect(status.stop?.reason).toBe('calendar_quiet_timeout');
      expect(call<boolean>(IPC.claim, session, status.stop?.requestId)).toBe(
        true,
      );
      expect(
        call<boolean>(IPC.acknowledge, session, status.stop?.requestId, true),
      ).toBe(true);
    } finally {
      service.stop();
    }
  });

  it('keeps recording if the calendar warning is not visible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    const onCalendarCheck = vi.fn(() => true);
    const service = registerDepartureService({
      executable: () => '/private/tmp/audiocap',
      getSetting: () => null,
      setSetting: () => undefined,
      requireRecordingOwner: () => undefined,
      requireCaptureStartOwner: () => undefined,
      log: vi.fn(),
      getCalendarEvent: () => ({
        start: '2026-10-15T11:00:00.000Z',
        end: '2026-10-15T12:00:05.000Z',
        isAllDay: false,
        isCancelled: false,
      }),
      onCalendarCheck,
      isCalendarCheckVisible: () => false,
    });
    try {
      call<DepartureStatus>(IPC.begin, 'calendar-warning-lost');
      const source = {
        id: 'us.zoom.xos:100:launch',
        bundleId: 'us.zoom.xos',
        pid: 100,
        name: 'Zoom',
        version: '1',
        input: true,
        output: true,
        audioGeneration: 'audio-1',
      };
      for (let second = 1; second <= 150; second++) {
        if (second === 5) {
          source.input = false;
          source.output = false;
        }
        mocks.activity?.({
          kind: 'activity',
          version: 1,
          epoch: 'helper-1',
          sequence: second,
          healthy: true,
          discontinuity: false,
          sources: [source],
          terminated: [],
        });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(onCalendarCheck).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: 'calendar-warning-lost' }),
        true,
      );
      expect(onCalendarCheck).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: 'calendar-warning-lost' }),
        false,
      );
      expect(
        (owner.send.mock.lastCall?.[1] as DepartureStatus).stop,
      ).toBeNull();
    } finally {
      service.stop();
    }
  });
});
