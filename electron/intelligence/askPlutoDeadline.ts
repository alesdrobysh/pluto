export interface AskPlutoDeadlineOptions {
  isLocal?: boolean;
}

export const askPlutoTimeoutMs = (
  modeOverride: 'auto' | 'fast' | 'deep' | undefined,
  options?: AskPlutoDeadlineOptions,
): number => {
  if (options?.isLocal) {
    // Auto can select the same deep local model as an explicit deep request.
    return modeOverride === 'fast' ? 90_000 : 120_000;
  }
  return modeOverride === 'deep' ? 60_000 : 30_000;
};

export interface RunAskPlutoWithDeadlineOptions {
  onProgressSetup?: (
    recordProgress: (phase?: 'queued' | 'started' | 'token') => void,
  ) => void;
  idleTimeoutMs?: number;
  queueTimeoutMs?: number;
}

export const runAskPlutoWithDeadline = async <Result>(
  work: Promise<Result>,
  controller: AbortController,
  timeoutMs: number,
  options?: RunAskPlutoWithDeadlineOptions,
): Promise<Result> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const idleTimeoutMs = options?.idleTimeoutMs ?? Math.min(timeoutMs, 45_000);

  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (controller.signal.aborted) onAbort();

  let rejectOnDeadline: ((reason: unknown) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectOnDeadline = reject;
  });

  const triggerTimeout = () => {
    const reason = new DOMException(
      'Ask Pluto response timed out',
      'TimeoutError',
    );
    controller.abort(reason);
    rejectOnDeadline?.(reason);
  };

  const scheduleDeadline = (durationMs: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(triggerTimeout, durationMs);
  };

  scheduleDeadline(timeoutMs);

  let queued = false;
  const recordProgress = (phase: 'queued' | 'started' | 'token' = 'token') => {
    // Starting the provider is not evidence of streaming progress. Keep the
    // initial allowance while a local model loads and evaluates the prompt.
    if (controller.signal.aborted) return;
    if (phase === 'queued') {
      queued = true;
      scheduleDeadline(options?.queueTimeoutMs ?? 300_000);
      return;
    }
    if (phase === 'started') {
      if (queued) scheduleDeadline(timeoutMs);
      queued = false;
      return;
    }
    queued = false;
    scheduleDeadline(idleTimeoutMs);
  };

  options?.onProgressSetup?.(recordProgress);

  try {
    return await Promise.race([work, deadline, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
};
