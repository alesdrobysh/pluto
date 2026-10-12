import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopCaptureResources } from '../../src/utils/captureShutdown';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const recorder = () => {
  const listeners = new Set<() => void>();
  return {
    state: 'recording',
    addEventListener: (_: 'stop', fn: () => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_: 'stop', fn: () => void) => {
      listeners.delete(fn);
    },
    stop: vi.fn(),
    finish: () => {
      for (const fn of listeners) fn();
    },
  };
};
const cleanup = () => ({
  releaseTracks: vi.fn(() => true),
  closeContext: vi.fn(async () => undefined),
});
afterEach(() => vi.useRealTimers());

describe('capture resource shutdown', () => {
  it('releases native capture and tracks without waiting for a missing recorder event', async () => {
    vi.useFakeTimers();
    const mic = recorder();
    const native = vi.fn(async () => true);
    const actions = cleanup();
    const pending = stopCaptureResources({
      recorder: mic,
      stopNative: native,
      ...actions,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(native).toHaveBeenCalledOnce();
    expect(actions.releaseTracks).toHaveBeenCalledOnce();
    expect(actions.closeContext).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({
      released: true,
      recorderCompleted: false,
    });
  });

  it('waits for both recorder completion and native acknowledgement', async () => {
    const mic = recorder();
    const native = deferred<boolean>();
    const settled = vi.fn();
    const pending = stopCaptureResources({
      recorder: mic,
      stopNative: () => native.promise,
      ...cleanup(),
    }).then(settled);
    mic.finish();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    native.resolve(true);
    await pending;
    expect(settled).toHaveBeenCalledWith({
      released: true,
      recorderCompleted: true,
    });
  });

  it.each(['recorder', 'listener', 'tracks', 'context', 'native'])(
    'continues the other cleanup steps after a %s exception',
    async (failure) => {
      const mic = recorder();
      if (failure === 'recorder')
        mic.stop.mockImplementation(() => {
          throw new Error('stop failed');
        });
      else mic.stop.mockImplementation(() => mic.finish());
      if (failure === 'listener')
        mic.addEventListener = () => {
          throw new Error('listener failed');
        };
      const actions = cleanup();
      if (failure === 'tracks')
        actions.releaseTracks.mockImplementation(() => {
          throw new Error('tracks failed');
        });
      if (failure === 'context')
        actions.closeContext.mockRejectedValue(new Error('context failed'));
      const stopNative = vi.fn(async () => {
        if (failure === 'native') throw new Error('IPC failed');
        return true;
      });
      const result = await stopCaptureResources({
        recorder: mic,
        stopNative,
        ...actions,
      });
      expect(stopNative).toHaveBeenCalledOnce();
      expect(actions.releaseTracks).toHaveBeenCalledOnce();
      expect(actions.closeContext).toHaveBeenCalledOnce();
      expect(result.released).toBe(
        failure === 'recorder' || failure === 'listener',
      );
    },
  );

  it('bounds hung IPC and context together and never reports a sent IPC as success', async () => {
    vi.useFakeTimers();
    const pending = stopCaptureResources({
      recorder: null,
      stopNative: () => new Promise(() => {}),
      releaseTracks: () => true,
      closeContext: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toEqual({
      released: false,
      recorderCompleted: true,
    });
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      stopCaptureResources({
        recorder: null,
        stopNative: async () => undefined,
        ...cleanup(),
      }),
    ).resolves.toMatchObject({ released: false });
  });
});
