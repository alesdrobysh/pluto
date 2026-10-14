// @vitest-environment happy-dom
import { type MutableRefObject, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DepartureStatus,
  DEPARTURE_IPC as IPC,
} from '../../electron/activeCall/departureTypes';
import { useAutoEndMonitor } from '../../src/hooks/useAutoEndMonitor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const baseStatus: DepartureStatus = {
  meetingId: 'meeting-1',
  generation: 'generation-1',
  phase: 'joined',
  source: null,
  candidates: [],
  unavailable: false,
  sessionAmbiguous: false,
  checkIn: false,
  calendarCheck: null,
  inspection: 'ready',
  stop: null,
};
const confirmed = (generation = 'generation-1'): DepartureStatus => ({
  ...baseStatus,
  generation,
  phase: 'departure_confirmed',
  stop: {
    meetingId: 'meeting-1',
    generation,
    requestId: 'request-1',
    reason: 'ui_departure',
    provider: 'zoom',
    sourceId: 'zoom-1',
    appName: 'Zoom',
  },
});

function setup(stop: (reason?: string) => Promise<boolean>, external = false) {
  let hook: ReturnType<typeof useAutoEndMonitor> | null = null;
  const reopen = vi.fn();
  const listeners = new Map<
    string,
    (_event: unknown, status: DepartureStatus) => void
  >();
  const invoke = vi.fn(async (channel: string) => {
    if (channel === IPC.begin) return baseStatus;
    if (channel === IPC.claim || channel === IPC.acknowledge) return true;
    if (channel === 'SHOW_MEETING_ENDED_ALERT') return external;
    return null;
  });
  Object.defineProperty(window, 'ipcRenderer', {
    configurable: true,
    value: {
      invoke,
      on: (
        channel: string,
        callback: (_event: unknown, status: DepartureStatus) => void,
      ) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      },
    },
  });
  const stopSessionRef: MutableRefObject<
    ((reason?: string) => Promise<boolean>) | null
  > = { current: stop };
  const Harness = () => {
    hook = useAutoEndMonitor({
      isRecording: true,
      meetingId: 'meeting-1',
      autoEndEnabled: true,
      onReopen: reopen,
      stopSessionRef,
    });
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const emit = async (status: DepartureStatus) => {
    await act(async () => {
      listeners.get(IPC.status)?.(null, status);
      await Promise.resolve();
    });
  };
  return { root, Harness, emit, invoke, getHook: () => hook, reopen,
    triggerReopen: () => listeners.get('MEETING_ENDED_REOPEN')?.(null, baseStatus) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutoEndMonitor bridge', () => {
  it('uses only a confirmed main-process request and acknowledges shared release', async () => {
    const stop = vi.fn(async () => true);
    const { root, Harness, emit, invoke } = setup(stop);
    await act(async () => root.render(createElement(Harness)));
    await emit(baseStatus);
    expect(stop).not.toHaveBeenCalled();
    await emit(confirmed('stale-generation'));
    expect(stop).not.toHaveBeenCalled();
    await emit(confirmed());
    expect(stop).toHaveBeenCalledExactlyOnceWith('auto:ui_departure:zoom');
    expect(invoke).toHaveBeenCalledWith(IPC.claim, confirmed(), 'request-1');
    expect(invoke).toHaveBeenCalledWith(
      IPC.acknowledge,
      confirmed(),
      'request-1',
      true,
    );
    await act(async () => root.unmount());
  });

  it('reports a failed release and permits a subsequent main-process retry', async () => {
    const stop = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { root, Harness, emit, invoke } = setup(stop);
    await act(async () => root.render(createElement(Harness)));
    await emit(confirmed());
    expect(invoke).toHaveBeenCalledWith(
      IPC.acknowledge,
      confirmed(),
      'request-1',
      false,
    );
    await emit(confirmed());
    expect(stop).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith(
      IPC.acknowledge,
      confirmed(),
      'request-1',
      true,
    );
    await act(async () => root.unmount());
  });

  it('dismisses the confirmed-stop notice after eight seconds', async () => {
    vi.useFakeTimers();
    const { root, Harness, emit, getHook } = setup(vi.fn(async () => true));
    await act(async () => root.render(createElement(Harness)));
    await emit(confirmed());
    expect(getHook()?.autoEndTriggered).toBe(true);
    await act(async () => vi.advanceTimersByTime(7_999));
    expect(getHook()?.autoEndTriggered).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(getHook()?.autoEndTriggered).toBe(false);
    await act(async () => root.unmount());
  });

  it('shows an external notice after release and routes Reopen back to Pluto', async () => {
    const { root, Harness, emit, invoke, getHook, reopen, triggerReopen } =
      setup(vi.fn(async () => true), true);
    await act(async () => root.render(createElement(Harness)));
    await emit(confirmed());
    expect(invoke).toHaveBeenCalledWith('SHOW_MEETING_ENDED_ALERT', {
      reason: 'ui_departure',
      appName: 'Zoom',
    });
    expect(getHook()?.autoEndTriggered).toBe(false);
    await act(async () => triggerReopen());
    expect(reopen).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
