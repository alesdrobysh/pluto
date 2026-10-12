export type MediaRecorderStopTarget = {
  readonly state: string;
  addEventListener: (
    type: 'stop',
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener?: (type: 'stop', listener: () => void) => void;
  stop: () => void;
};

const stopCompletions = new WeakMap<
  MediaRecorderStopTarget,
  Promise<boolean>
>();

export const waitForMediaRecorderStop = (
  recorder: MediaRecorderStopTarget,
  timeoutMs: number,
): Promise<boolean> => {
  let stopCompletion = stopCompletions.get(recorder);
  if (!stopCompletion) {
    if (recorder.state === 'inactive') return Promise.resolve(true);

    stopCompletion = new Promise((resolve) => {
      const handleStop = () => {
        try {
          recorder.removeEventListener?.('stop', handleStop);
        } catch {
          /* Stop is still confirmed. */
        }
        resolve(true);
      };

      try {
        recorder.addEventListener('stop', handleStop, { once: true });
        recorder.stop();
      } catch {
        try {
          recorder.removeEventListener?.('stop', handleStop);
        } catch {
          /* Cleanup failure is reported below. */
        }
        resolve(false);
      }
    });
    stopCompletions.set(recorder, stopCompletion);
    void stopCompletion.finally(() => {
      if (stopCompletions.get(recorder) === stopCompletion) {
        stopCompletions.delete(recorder);
      }
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finishAttempt = (stopped: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(stopped);
    };
    const timeout = setTimeout(() => finishAttempt(false), timeoutMs);
    void stopCompletion.then(finishAttempt);
  });
};
