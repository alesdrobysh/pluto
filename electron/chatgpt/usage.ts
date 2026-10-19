import { createHash } from 'node:crypto';
import type { InferenceRequest, InferenceResult } from '../llm/inferenceTypes';
import {
  LLM_WORK_CLASS_PRIORITY,
  defaultLLMWorkClass,
} from '../llm/llmWorkClass';
import { createSerializedTaskGate } from '../serializedTaskGate';
import { ChatGPTError } from './auth';
import {
  CHATGPT_DEFAULT_USAGE_POLICY,
  CHATGPT_MIN_REQUEST_TOKEN_RESERVATION,
  type ChatGPTUsagePolicy,
  chatGPTBackgroundBudget,
} from './usagePolicy';
export type { ChatGPTUsagePolicy } from './usagePolicy';
type Counts = {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  unmeasuredRequests: number;
  estimatedTokens: number;
};
type Day = Counts & {
  backgroundRequests: number;
  backgroundTokens: number;
  duplicatesAvoided: number;
  tasks: Record<string, Counts>;
};
type State = {
  version: 1;
  policy: ChatGPTUsagePolicy;
  paused: boolean;
  days: Record<string, Day>;
};
export type ChatGPTUsageSummary = Day & {
  day: string;
  policy: ChatGPTUsagePolicy;
  paused: boolean;
};
type Storage = {
  getSetting(key: string): unknown;
  setSetting(key: string, value: string): unknown;
};
export type ChatGPTCallbacks = {
  onToken?: (text: string) => void;
  onProgress?: () => void;
  onStart?: () => void;
};
const KEY = 'chatgpt_usage_v1';
const counts = (): Counts => ({
  requests: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  unmeasuredRequests: 0,
  estimatedTokens: 0,
});
const dayCounts = (): Day => ({
  ...counts(),
  backgroundRequests: 0,
  backgroundTokens: 0,
  duplicatesAvoided: 0,
  tasks: {},
});
const number = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const policyValid = (value: ChatGPTUsagePolicy) =>
  value &&
  Number.isInteger(value.dailyRequests) &&
  value.dailyRequests >= 1 &&
  value.dailyRequests <= 1000 &&
  Number.isInteger(value.dailyTokens) &&
  value.dailyTokens >= 1000 &&
  value.dailyTokens <= 10_000_000 &&
  typeof value.backgroundEnabled === 'boolean';

/** Content-free, profile-local admission ledger. Reservations survive failed requests and restarts. */
export class ChatGPTUsage {
  private readonly gate = createSerializedTaskGate<symbol, InferenceResult>();
  private readonly pending = new Map<
    string,
    {
      controller: AbortController;
      listeners: Set<ChatGPTCallbacks>;
      text: string;
      started: boolean;
      background: boolean;
      promise: Promise<InferenceResult>;
    }
  >();
  private readonly scopes = new WeakMap<AbortSignal, number>();
  private readonly completed = new Map<
    string,
    { result: InferenceResult; expiresAt: number }
  >();
  private nextScope = 0;
  constructor(
    private readonly storage: Storage,
    private readonly now = () => new Date(),
  ) {}

  private day() {
    const date = this.now();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  private read(): State {
    const raw = this.storage.getSetting(KEY);
    if (raw == null || raw === '')
      return {
        version: 1,
        policy: { ...CHATGPT_DEFAULT_USAGE_POLICY },
        paused: false,
        days: {},
      };
    try {
      const state = JSON.parse(String(raw)) as State;
      if (
        state.version !== 1 ||
        !policyValid(state.policy) ||
        typeof state.paused !== 'boolean' ||
        !state.days ||
        typeof state.days !== 'object'
      )
        throw new Error();
      for (const [key, day] of Object.entries(state.days)) {
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(key) ||
          !day.tasks ||
          !number(day.backgroundRequests) ||
          !number(day.duplicatesAvoided)
        )
          throw new Error();
        for (const item of [day, ...Object.values(day.tasks)])
          for (const key of Object.keys(counts()) as Array<keyof Counts>)
            if (!number(item[key])) throw new Error();
      }
      // Old ledgers did not separate background tokens; never give them a fresh allowance.
      for (const day of Object.values(state.days)) {
        if (day.backgroundTokens === undefined)
          day.backgroundTokens =
            day.backgroundRequests > 0
              ? day.inputTokens + day.outputTokens + day.estimatedTokens
              : 0;
        if (!number(day.backgroundTokens)) throw new Error();
      }
      return state;
    } catch {
      throw new ChatGPTError('chatgpt_usage_storage_error');
    }
  }
  private write(state: State) {
    const keep = Object.keys(state.days).sort().reverse().slice(0, 30);
    state.days = Object.fromEntries(keep.map((key) => [key, state.days[key]]));
    this.storage.setSetting(KEY, JSON.stringify(state));
  }
  summary(): ChatGPTUsageSummary {
    const state = this.read();
    return {
      ...(state.days[this.day()] ?? dayCounts()),
      day: this.day(),
      policy: state.policy,
      paused: state.paused,
    };
  }
  setPolicy(policy: ChatGPTUsagePolicy) {
    if (!policyValid(policy))
      throw new ChatGPTError('chatgpt_usage_policy_invalid');
    const state = this.read();
    state.policy = {
      dailyRequests: policy.dailyRequests,
      dailyTokens: policy.dailyTokens,
      backgroundEnabled: policy.backgroundEnabled,
    };
    this.write(state);
    if (!policy.backgroundEnabled)
      for (const entry of this.pending.values())
        if (entry.background)
          entry.controller.abort(new ChatGPTError('chatgpt_background_paused'));
    return this.summary();
  }
  pause(paused: boolean) {
    const state = this.read();
    state.paused = paused;
    this.write(state);
  }
  backgroundAvailable() {
    try {
      const summary = this.summary();
      return (
        this.requestsAvailable() &&
        summary.policy.backgroundEnabled &&
        summary.backgroundRequests <
          chatGPTBackgroundBudget(summary.policy).requests &&
        summary.backgroundTokens + CHATGPT_MIN_REQUEST_TOKEN_RESERVATION <=
          chatGPTBackgroundBudget(summary.policy).tokens
      );
    } catch {
      return false;
    }
  }
  requestsAvailable() {
    try {
      const summary = this.summary();
      return (
        !summary.paused &&
        summary.requests < summary.policy.dailyRequests &&
        summary.inputTokens +
          summary.outputTokens +
          summary.estimatedTokens +
          CHATGPT_MIN_REQUEST_TOKEN_RESERVATION <=
          summary.policy.dailyTokens
      );
    } catch {
      return false;
    }
  }
  private reserve(request: InferenceRequest, background: boolean) {
    const state = this.read();
    if (state.paused)
      throw new ChatGPTError('subscription_sharing_usage_limit_exceeded');
    const key = this.day();
    state.days[key] ??= dayCounts();
    const day = state.days[key];
    if (background && !state.policy.backgroundEnabled)
      throw new ChatGPTError('chatgpt_background_paused');
    // SIWC cannot enforce max_output_tokens. Reserve a conservative allowance;
    // this is an admission estimate, never a claim about the upstream quota.
    const estimated =
      Math.ceil(
        JSON.stringify({
          messages: request.messages,
          schema: request.responseSchema,
        }).length / 3,
      ) +
      Math.max(
        CHATGPT_MIN_REQUEST_TOKEN_RESERVATION,
        request.maxOutputTokens ?? 0,
      );
    const backgroundBudget = chatGPTBackgroundBudget(state.policy);
    if (
      background &&
      (day.backgroundRequests >= backgroundBudget.requests ||
        day.backgroundTokens + estimated > backgroundBudget.tokens)
    )
      throw new ChatGPTError('chatgpt_background_limit');
    if (
      day.requests + (request.task === 'askPlutoScope' ? 2 : 1) >
        state.policy.dailyRequests ||
      day.inputTokens +
        day.outputTokens +
        day.estimatedTokens +
        estimated +
        (request.task === 'askPlutoScope'
          ? CHATGPT_MIN_REQUEST_TOKEN_RESERVATION
          : 0) >
        state.policy.dailyTokens
    )
      throw new ChatGPTError('chatgpt_daily_limit');
    const taskKey = `${request.task} (${request.model})`;
    day.tasks[taskKey] ??= counts();
    const task = day.tasks[taskKey];
    for (const item of [day, task]) {
      item.requests++;
      item.unmeasuredRequests++;
      item.estimatedTokens += estimated;
    }
    if (background) {
      day.backgroundRequests++;
      day.backgroundTokens += estimated;
    }
    this.write(state); // Commit before egress, including when a previous process crashed.
    return (result?: InferenceResult) => {
      const latest = this.read();
      const day = latest.days[key];
      if (!day) return;
      for (const item of [day, day.tasks[taskKey]]) {
        if (!result) item.failed++;
        if (
          number(result?.usage.inputTokens) &&
          number(result?.usage.outputTokens)
        ) {
          item.unmeasuredRequests--;
          item.estimatedTokens -= estimated;
          item.inputTokens += result!.usage.inputTokens!;
          item.outputTokens += result!.usage.outputTokens!;
        }
      }
      if (
        background &&
        number(result?.usage.inputTokens) &&
        number(result?.usage.outputTokens)
      )
        day.backgroundTokens +=
          result!.usage.inputTokens! + result!.usage.outputTokens! - estimated;
      this.write(latest);
    };
  }

  run(
    request: InferenceRequest,
    scope: AbortSignal,
    callbacks: ChatGPTCallbacks,
    execute: (
      signal: AbortSignal,
      callbacks: ChatGPTCallbacks,
    ) => Promise<InferenceResult>,
  ): Promise<InferenceResult> {
    if (request.signal?.aborted || scope.aborted)
      return Promise.reject(request.signal?.reason ?? scope.reason);
    const workClass = request.workClass ?? defaultLLMWorkClass(request.task);
    if (!this.scopes.has(scope)) {
      this.scopes.set(scope, ++this.nextScope);
      scope.addEventListener('abort', () => this.completed.clear(), {
        once: true,
      });
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          scope: this.scopes.get(scope),
          task: request.task,
          model: request.model,
          messages: request.messages,
          schema: request.responseSchema,
          strict: request.responseSchemaStrict,
          json: request.jsonMode,
          workClass,
        }),
      )
      .digest('hex');
    const reusable =
      workClass === 'meeting_secondary' ||
      workClass === 'background' ||
      request.task === 'notesAudit' ||
      request.task === 'askPlutoScope';
    for (const [key, value] of this.completed)
      if (value.expiresAt <= this.now().getTime()) this.completed.delete(key);
    const cached = this.completed.get(key);
    if (cached && reusable) {
      const state = this.read();
      if (
        !state.paused &&
        (workClass !== 'background' || state.policy.backgroundEnabled)
      ) {
        state.days[this.day()] ??= dayCounts();
        state.days[this.day()].duplicatesAvoided++;
        this.write(state);
        callbacks.onStart?.();
        callbacks.onToken?.(cached.result.text);
        callbacks.onProgress?.();
        return Promise.resolve(cached.result);
      }
    }
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      const listeners = new Set<ChatGPTCallbacks>();
      entry = {
        controller,
        listeners,
        text: '',
        started: false,
        background: workClass === 'background',
        promise: Promise.resolve(null as never),
      };
      const current = entry;
      this.pending.set(key, current);
      const combined = AbortSignal.any([scope, controller.signal]);
      current.promise = this.gate(
        Symbol(request.task),
        async (gateSignal) => {
          gateSignal.throwIfAborted();
          const finish = this.reserve(request, workClass === 'background');
          let result: InferenceResult | undefined;
          try {
            current.started = true;
            for (const listener of listeners) listener.onStart?.();
            gateSignal.throwIfAborted();
            result = await execute(gateSignal, {
              onToken: (delta) => {
                current.text += delta;
                for (const listener of listeners) listener.onToken?.(delta);
              },
              onProgress: () => {
                for (const listener of listeners) listener.onProgress?.();
              },
            });
            gateSignal.throwIfAborted();
            if (reusable && result.text.length <= 256_000) {
              if (this.completed.size >= 64)
                this.completed.delete(this.completed.keys().next().value!);
              this.completed.set(key, {
                result,
                expiresAt: this.now().getTime() + 10 * 60_000,
              });
            }
            return result;
          } finally {
            finish(result);
          }
        },
        LLM_WORK_CLASS_PRIORITY[workClass],
        { signal: combined, preemptible: false },
      );
      const cleanup = () => {
        if (this.pending.get(key) === current) this.pending.delete(key);
      };
      void current.promise.then(cleanup, cleanup);
    } else {
      const state = this.read();
      state.days[this.day()] ??= dayCounts();
      state.days[this.day()].duplicatesAvoided++;
      this.write(state);
    }
    const shared = entry;
    const subscriber = { ...callbacks };
    shared.listeners.add(subscriber);
    if (shared.started) subscriber.onStart?.();
    if (shared.text) subscriber.onToken?.(shared.text);
    return new Promise((resolve, reject) => {
      const signal = request.signal;
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        shared.listeners.delete(subscriber);
      };
      const abort = () => {
        cleanup();
        if (!shared.listeners.size) shared.controller.abort(signal?.reason);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      void shared.promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      if (signal?.aborted) abort();
    });
  }
}

export function createMemoryChatGPTUsage() {
  const settings = new Map<string, string>();
  return new ChatGPTUsage({
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
  });
}
