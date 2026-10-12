import type { ChildProcess } from 'node:child_process';

export const canReuseRunningCaptureForProbe = (
  captureRunning: boolean,
  targetPids?: number[],
) =>
  captureRunning &&
  !targetPids?.some((pid) => Number.isInteger(pid) && pid > 0);

type PcmEventSource = {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  off(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
};

type NativePcmProcess = {
  stdout: PcmEventSource | null;
  once(event: 'error' | 'close', listener: () => void): unknown;
  off(event: 'error' | 'close', listener: () => void): unknown;
};

/** A spawned process is not ready until its PCM transport produces a frame. */
export const waitForNativeAudioPcm = (
  child: NativePcmProcess,
  timeoutMs = 3000,
): Promise<boolean> =>
  new Promise((resolve) => {
    const firstFrame = new Uint8Array(4);
    let byteCount = 0;
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      child.off('error', failed);
      child.off('close', failed);
      child.stdout?.off('data', received);
      resolve(ready);
    };
    const failed = () => finish(false);
    const received = (chunk: Uint8Array) => {
      for (const byte of chunk) {
        firstFrame[byteCount++] = byte;
        if (byteCount === 4) {
          finish(
            Number.isFinite(
              new DataView(firstFrame.buffer).getFloat32(0, true),
            ),
          );
          return;
        }
      }
    };
    const timer = setTimeout(failed, timeoutMs);
    child.once('error', failed);
    child.once('close', failed);
    child.stdout?.on('data', received);
  });

export type NativeStopEvent =
  | 'native_stop_requested'
  | 'native_stop_escalated'
  | 'native_stop_confirmed'
  | 'native_stop_failed';

const stoppingChildren = new WeakMap<ChildProcess, Promise<boolean>>();

/** Keep the owner/transport alive until close drains the child's final bytes. */
export const stopNativeAudioProcess = (
  child: ChildProcess,
  onEvent: (event: NativeStopEvent) => void = () => {},
): Promise<boolean> => {
  const pending = stoppingChildren.get(child);
  if (pending) return pending;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (
    exited() &&
    [child.stdout, child.stderr].every(
      (stream) => !stream || stream.readableEnded || stream.destroyed,
    )
  ) {
    return Promise.resolve(true);
  }
  const result = new Promise<boolean>((resolve) => {
    let finished = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const report = (event: NativeStopEvent) => {
      try {
        onEvent(event);
      } catch {
        /* Diagnostics cannot block shutdown. */
      }
    };
    const finish = (stopped: boolean) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      child.off('close', closed);
      report(stopped ? 'native_stop_confirmed' : 'native_stop_failed');
      resolve(stopped);
    };
    const closed = () => finish(true);
    const signal = (value: NodeJS.Signals) => {
      if (finished || exited()) return;
      try {
        child.kill(value);
      } catch {
        /* Escalation/close remains authoritative. */
      }
    };
    child.once('close', closed);
    report('native_stop_requested');
    timers.push(
      setTimeout(() => {
        report('native_stop_escalated');
        signal('SIGTERM');
      }, 1_000),
    );
    timers.push(setTimeout(() => signal('SIGKILL'), 2_000));
    timers.push(setTimeout(() => finish(false), 3_000));
    signal('SIGINT');
  });
  stoppingChildren.set(child, result);
  void result.then(() => {
    if (stoppingChildren.get(child) === result) stoppingChildren.delete(child);
  });
  return result;
};
