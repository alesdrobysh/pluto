import {
  type MediaRecorderStopTarget,
  waitForMediaRecorderStop,
} from './mediaRecorderLifecycle';

export type CaptureStopResult = {
  released: boolean;
  recorderCompleted: boolean;
};

/** Independent cleanup, one deadline, and no success inferred from a sent IPC. */
export const stopCaptureResources = async (input: {
  recorder: MediaRecorderStopTarget | null;
  stopNative: () => Promise<unknown>;
  releaseTracks: () => boolean;
  closeContext: () => Promise<unknown>;
}): Promise<CaptureStopResult> => {
  const bounded = async (work: () => Promise<unknown>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(work)
          .then(
            (value) => value !== false,
            () => false,
          ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 4_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Schedule native release before touching renderer resources that may throw.
  const native = bounded(async () => (await input.stopNative()) === true);
  let recorder = Promise.resolve(true);
  try {
    if (input.recorder)
      recorder = waitForMediaRecorderStop(input.recorder, 1_000).catch(
        () => false,
      );
  } catch {
    recorder = Promise.resolve(false);
  }
  let tracksReleased = false;
  try {
    tracksReleased = input.releaseTracks();
  } catch {
    /* Still close context/native. */
  }
  const context = bounded(input.closeContext);
  const [nativeReleased, recorderCompleted, contextClosed] = await Promise.all([
    native,
    recorder,
    context,
  ]);
  return {
    released: nativeReleased && tracksReleased && contextClosed,
    recorderCompleted,
  };
};
