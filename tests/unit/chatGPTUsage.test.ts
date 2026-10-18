import { describe, expect, it, vi } from 'vitest';
import { ChatGPTUsage } from '../../electron/chatgpt/usage';
import { runAskPlutoWithDeadline } from '../../electron/intelligence/askPlutoDeadline';
import type {
  InferenceRequest,
  InferenceResult,
} from '../../electron/llm/inferenceTypes';

const request: InferenceRequest = {
  task: 'notesWriter',
  model: 'fictional-model',
  messages: [{ role: 'user', content: 'private fictional transcript' }],
  egress: { classification: 'selected_meeting_context', userInitiated: true },
};
const result: InferenceResult = {
  text: 'grounded answer',
  provider: 'chatgpt',
  finishReason: 'stop',
  requestedModel: 'fictional-model',
  resolvedModel: 'fictional-model',
  latencyMs: 1,
  usage: { inputTokens: 100, outputTokens: 20 },
};
const setup = () => {
  const settings = new Map<string, string>();
  const storage = {
    getSetting: (key: string) => settings.get(key),
    setSetting: (key: string, value: string) => settings.set(key, value),
  };
  let now = new Date(2026, 9, 15, 10);
  return {
    settings,
    storage,
    usage: new ChatGPTUsage(storage, () => now),
    nextDay: () => {
      now = new Date(2026, 9, 16, 10);
    },
    clock: () => now,
  };
};
const scope = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('ChatGPT usage protection', () => {
  it('reuses an identical semantic notes audit but still charges each explicit writer', async () => {
    const { usage } = setup();
    const account = scope();
    const execute = vi.fn(async () => result);
    const audit = {
      ...request,
      task: 'notesAudit',
      workClass: 'manual_notes',
    } as InferenceRequest;
    await usage.run(audit, account, {}, execute);
    await usage.run(audit, account, {}, execute);
    await usage.run({ ...audit, model: 'changed-model' }, account, {}, execute);
    await usage.run(request, account, {}, execute);
    await usage.run(request, account, {}, execute);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(usage.summary()).toMatchObject({
      requests: 4,
      duplicatesAvoided: 1,
    });
  });

  it('persists measured tokens and failed reservations without storing content, then resets the daily counter', async () => {
    const { usage, storage, settings, clock, nextDay } = setup();
    const run = vi.fn(async () => result);
    await usage.run(request, scope(), {}, run);
    await expect(
      usage.run(request, scope(), {}, async () => {
        throw new Error('network');
      }),
    ).rejects.toThrow('network');
    const reopened = new ChatGPTUsage(storage, clock);
    expect(reopened.summary()).toMatchObject({
      requests: 2,
      failed: 1,
      inputTokens: 100,
      outputTokens: 20,
      unmeasuredRequests: 1,
    });
    expect(reopened.summary().estimatedTokens).toBeGreaterThan(8192);
    expect([...settings.values()].join()).not.toMatch(
      /private fictional transcript|grounded answer/,
    );
    nextDay();
    expect(reopened.summary().requests).toBe(0);
  });

  it('blocks egress at the daily request and token budgets, including after reopening', async () => {
    const { usage, storage, clock } = setup();
    usage.setPolicy({
      dailyRequests: 1,
      dailyTokens: 200000,
      backgroundEnabled: false,
    });
    const run = vi.fn(async () => result);
    await usage.run(request, scope(), {}, run);
    await expect(
      new ChatGPTUsage(storage, clock).run(request, scope(), {}, run),
    ).rejects.toMatchObject({ code: 'chatgpt_daily_limit' });
    expect(run).toHaveBeenCalledTimes(1);
    usage.setPolicy({
      dailyRequests: 50,
      dailyTokens: 1000,
      backgroundEnabled: false,
    });
    await expect(usage.run(request, scope(), {}, run)).rejects.toMatchObject({
      code: 'chatgpt_daily_limit',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shares one streaming request while cancellation only detaches that subscriber', async () => {
    const { usage } = setup();
    const account = scope();
    const cancelled = new AbortController();
    let finish!: (result: InferenceResult) => void;
    let emit!: (text: string) => void;
    const run = vi.fn(async (_signal, callbacks) => {
      emit = callbacks.onToken;
      return new Promise<InferenceResult>((resolve) => {
        finish = resolve;
      });
    });
    const firstTokens = vi.fn();
    const secondTokens = vi.fn();
    const first = usage.run(
      { ...request, signal: cancelled.signal },
      account,
      { onToken: firstTokens },
      run,
    );
    const firstFailure = first.catch((error) => error);
    await tick();
    emit('first ');
    const second = usage.run(request, account, { onToken: secondTokens }, run);
    cancelled.abort(new DOMException('cancelled', 'AbortError'));
    emit('second');
    finish(result);
    expect((await firstFailure).name).toBe('AbortError');
    expect(await second).toEqual(result);
    expect(run).toHaveBeenCalledTimes(1);
    expect(secondTokens.mock.calls.flat().join('')).toBe('first second');
    expect(firstTokens.mock.calls.flat().join('')).toBe('first ');
    expect(usage.summary()).toMatchObject({
      requests: 1,
      duplicatesAvoided: 1,
    });
  });

  it('cancels an abandoned queued request without reserving usage', async () => {
    const { usage } = setup();
    let finish!: (result: InferenceResult) => void;
    const first = usage.run(
      request,
      scope(),
      {},
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await tick();
    const cancelled = new AbortController();
    const run = vi.fn(async () => result);
    const queued = usage
      .run(
        { ...request, task: 'askPluto', signal: cancelled.signal },
        scope(),
        {},
        run,
      )
      .catch((error) => error);
    cancelled.abort(new DOMException('cancelled', 'AbortError'));
    finish(result);
    await first;
    expect((await queued).name).toBe('AbortError');
    await tick();
    expect(run).not.toHaveBeenCalled();
    expect(usage.summary().requests).toBe(1);
  });

  it('aborts active upstream work only when its last subscriber leaves and retains the reservation', async () => {
    const { usage } = setup();
    const caller = new AbortController();
    let upstream!: AbortSignal;
    const outcome = usage
      .run(
        { ...request, signal: caller.signal },
        scope(),
        {},
        async (signal) => {
          upstream = signal;
          return new Promise<InferenceResult>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      )
      .catch((error) => error);
    await tick();
    caller.abort(new DOMException('cancelled', 'AbortError'));
    expect((await outcome).name).toBe('AbortError');
    await tick();
    expect(upstream.aborted).toBe(true);
    expect(usage.summary()).toMatchObject({
      requests: 1,
      failed: 1,
      unmeasuredRequests: 1,
    });
  });

  it('records an output exceeding its reservation and blocks subsequent requests', async () => {
    const { usage } = setup();
    const run = vi.fn(async () => ({
      ...result,
      usage: { inputTokens: 1000, outputTokens: 210000 },
    }));
    await usage.run(request, scope(), {}, run);
    expect(usage.summary().outputTokens).toBe(210000);
    await expect(usage.run(request, scope(), {}, run)).rejects.toMatchObject({
      code: 'chatgpt_daily_limit',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('defaults optional background work off, allows explicit reviews, and limits opted-in work to ten requests', async () => {
    const { usage } = setup();
    const run = vi.fn(async () => result);
    await expect(
      usage.run({ ...request, task: 'knowledgeDoc' }, scope(), {}, run),
    ).rejects.toMatchObject({ code: 'chatgpt_background_paused' });
    await usage.run(
      { ...request, task: 'knowledgeDoc', workClass: 'project_review' },
      scope(),
      {},
      run,
    );
    usage.setPolicy({
      dailyRequests: 50,
      dailyTokens: 200000,
      backgroundEnabled: true,
    });
    for (let i = 0; i < 10; i++)
      await usage.run({ ...request, task: 'dreaming' }, scope(), {}, run);
    await expect(
      usage.run({ ...request, task: 'dreaming' }, scope(), {}, run),
    ).rejects.toMatchObject({ code: 'chatgpt_background_limit' });
    expect(usage.summary().backgroundRequests).toBe(10);
    expect(usage.backgroundAvailable()).toBe(false);
  });

  it('persists upstream pauses, fails closed on a damaged ledger, and rejects invalid policies', async () => {
    const { usage, storage, settings } = setup();
    usage.pause(true);
    const reopened = new ChatGPTUsage(storage);
    await expect(
      reopened.run(request, scope(), {}, vi.fn()),
    ).rejects.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
    });
    expect(() =>
      usage.setPolicy({
        dailyRequests: -1,
        dailyTokens: 200000,
        backgroundEnabled: true,
      }),
    ).toThrow();
    settings.set('chatgpt_usage_v1', '{broken');
    await expect(
      reopened.run(request, scope(), {}, vi.fn()),
    ).rejects.toMatchObject({ code: 'chatgpt_usage_storage_error' });
  });

  it('isolates model and account changes and never serves a completed response as a stale cache', async () => {
    const { usage } = setup();
    const run = vi.fn(async () => result);
    const account = scope();
    await usage.run(request, account, {}, run);
    await tick();
    await usage.run(request, account, {}, run);
    await tick();
    await usage.run({ ...request, model: 'different-model' }, account, {}, run);
    await usage.run(request, scope(), {}, run);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('reuses exact secondary work only, invalidates on input/model/account changes, and expires the cache', async () => {
    const { usage, nextDay } = setup();
    const account = new AbortController();
    const run = vi.fn(async () => result);
    const secondary = { ...request, task: 'entities' };
    await usage.run(secondary, account.signal, {}, run);
    await usage.run(secondary, account.signal, {}, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(usage.summary().duplicatesAvoided).toBe(1);
    await usage.run(
      { ...secondary, messages: [{ role: 'user', content: 'changed source' }] },
      account.signal,
      {},
      run,
    );
    await usage.run(
      { ...secondary, model: 'changed-model' },
      account.signal,
      {},
      run,
    );
    nextDay();
    await usage.run(secondary, account.signal, {}, run);
    account.abort();
    await usage.run(secondary, scope(), {}, run);
    expect(run).toHaveBeenCalledTimes(5);
  });
});

it('waits behind paid secondary work without spending the interactive response deadline or admitting duplicates', async () => {
  vi.useFakeTimers();
  try {
    const { usage } = setup();
    const secondary = usage.run(
      { ...request, task: 'entities' },
      scope(),
      {},
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 70_000));
        return result;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    let progress:
      | ((phase?: 'queued' | 'started' | 'token') => void)
      | undefined;
    const work = Promise.resolve().then(() => {
      progress?.('queued');
      return usage.run(
        { ...request, task: 'askPluto', signal: controller.signal },
        scope(),
        { onStart: () => progress?.('started') },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          return result;
        },
      );
    });
    const answer = runAskPlutoWithDeadline(work, controller, 30_000, {
      onProgressSetup: (fn) => {
        progress = fn;
      },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(usage.summary().requests).toBe(1);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    await secondary;
    await answer;
    expect(usage.summary()).toMatchObject({
      requests: 2,
      failed: 0,
      estimatedTokens: 0,
    });
  } finally {
    vi.useRealTimers();
  }
});

it('does not announce dispatch or reserve tokens for cancelled queued work', async () => {
  const { usage } = setup();
  let finish!: (value: InferenceResult) => void;
  const secondary = usage.run(
    request,
    scope(),
    {},
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await tick();
  const controller = new AbortController();
  const onStart = vi.fn();
  const execute = vi.fn(async () => result);
  const queued = usage.run(
    { ...request, task: 'askPluto', signal: controller.signal },
    scope(),
    { onStart },
    execute,
  );
  const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(new DOMException('Stopped', 'AbortError'));
  await rejected;
  finish(result);
  await secondary;
  expect(onStart).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(usage.summary().requests).toBe(1);
});

it('reuses semantic scope within its account and catalog, while preserving quota and pause safeguards', async () => {
  const { usage } = setup();
  const account = new AbortController();
  const execute = vi.fn(async () => result);
  const plan = {
    ...request,
    task: 'askPlutoScope',
    messages: [
      { role: 'user' as const, content: 'complete catalog v1 and question' },
    ],
  };
  await usage.run(plan, account.signal, {}, execute);
  await usage.run(plan, account.signal, {}, execute);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(usage.summary().requests).toBe(1);
  expect(usage.summary().duplicatesAvoided).toBe(1);
  expect(usage.summary().backgroundRequests).toBe(0);
  await usage.run(
    {
      ...plan,
      messages: [{ role: 'user', content: 'complete catalog v2 and question' }],
    },
    account.signal,
    {},
    execute,
  );
  expect(execute).toHaveBeenCalledTimes(2);
  usage.pause(true);
  await expect(
    usage.run(plan, account.signal, {}, execute),
  ).rejects.toMatchObject({
    code: 'subscription_sharing_usage_limit_exceeded',
  });
  usage.pause(false);
  usage.setPolicy({
    dailyRequests: 2,
    dailyTokens: 200000,
    backgroundEnabled: false,
  });
  await expect(
    usage.run({ ...plan, model: 'other-model' }, account.signal, {}, execute),
  ).rejects.toMatchObject({ code: 'chatgpt_daily_limit' });
  expect(execute).toHaveBeenCalledTimes(2);
});

it('does not spend a fresh scope request when no request remains for the answer, but permits cached scope reuse', async () => {
  const { usage } = setup();
  const account = scope();
  const execute = vi.fn(async () => result);
  const plan = { ...request, task: 'askPlutoScope' };
  usage.setPolicy({
    dailyRequests: 1,
    dailyTokens: 200000,
    backgroundEnabled: false,
  });
  await expect(usage.run(plan, account, {}, execute)).rejects.toMatchObject({
    code: 'chatgpt_daily_limit',
  });
  expect(execute).not.toHaveBeenCalled();
  expect(usage.summary().requests).toBe(0);
  usage.setPolicy({
    dailyRequests: 2,
    dailyTokens: 200000,
    backgroundEnabled: false,
  });
  await usage.run(plan, account, {}, execute);
  await usage.run(plan, account, {}, execute);
  await usage.run({ ...request, task: 'askPluto' }, account, {}, execute);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(usage.summary().requests).toBe(2);
});
