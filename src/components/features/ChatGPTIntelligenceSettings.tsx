import { useEffect, useState } from 'react';
import type {
  ChatGPTModel,
  ChatGPTStatus,
} from '../../../electron/chatgpt/types';
import type {
  ChatGPTUsagePolicy,
  ChatGPTUsageSummary,
} from '../../../electron/chatgpt/usage';
import chatGPTLogo from '../../assets/brand/chatgpt.svg';

export function ChatGPTIntelligenceSettings() {
  const [status, setStatus] = useState<ChatGPTStatus | null>(null);
  const [models, setModels] = useState<ChatGPTModel[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<
    'sign-in' | 'sign-out' | 'models' | 'usage' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatGPTUsageSummary | null>(null);
  const [policy, setPolicy] = useState<ChatGPTUsagePolicy | null>(null);
  const invoke = (channel: string, ...args: unknown[]) =>
    window.ipcRenderer.invoke(channel, ...args);
  const buttonClass =
    'rounded-lg border border-pro-border px-3 py-2 text-[13px] font-medium text-pro-text-main transition-colors hover:bg-pro-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent disabled:opacity-50';

  const refresh = async () => {
    const next = (await invoke('CHATGPT_STATUS')) as ChatGPTStatus;
    setStatus(next);
    const usageSummary = (await invoke('CHATGPT_USAGE')) as
      | ChatGPTUsageSummary
      | undefined;
    if (usageSummary) {
      setUsage(usageSummary);
      setPolicy(usageSummary.policy);
    }
    if (next?.planEnabled) {
      const available = (await invoke('CHATGPT_MODELS')) as ChatGPTModel[];
      setModels(available);
      const selected = await invoke('GET_SETTING', 'chatgpt_model');
      setModel(typeof selected === 'string' ? selected : '');
      if (!available.length)
        setError(
          'No ChatGPT models are available for this account. Check your plan and workspace access.',
        );
    } else {
      setModels([]);
      setModel('');
    }
  };

  useEffect(() => {
    let mounted = true;
    void refresh().catch(() => {
      if (mounted)
        setError(
          'Could not load ChatGPT access. Try refreshing the connection.',
        );
    });
    const updateStatus = () => {
      void invoke('CHATGPT_STATUS')
        .then((next) => {
          if (mounted) setStatus(next);
        })
        .catch(() => {});
      void invoke('CHATGPT_USAGE')
        .then((next) => {
          if (mounted && next) setUsage(next);
        })
        .catch(() => {});
    };
    window.addEventListener('focus', updateStatus);
    const timer = setInterval(updateStatus, 15_000);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('focus', updateStatus);
    };
  }, []);

  const run = async (
    action: 'sign-in' | 'sign-out' | 'models' | 'usage',
    callback: () => Promise<void>,
  ) => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      await callback();
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              '',
            )
          : 'ChatGPT could not connect. Try again.';
      setError(message);
      await invoke('CHATGPT_STATUS')
        .then(setStatus)
        .catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-5 text-pro-text-muted">
        Use your eligible ChatGPT Plus or Pro plan for all Pluto intelligence,
        including background People and Project updates. Requests use your plan
        allowance. Recording and transcription stay on this Mac; relevant text
        context goes to OpenAI.
      </p>
      <p role="status" className="text-[13px] text-pro-text-main">
        {status?.connected
          ? `${status.email ?? 'ChatGPT account'} · ${status.planEnabled ? 'Plan usage enabled' : 'Plan usage not enabled'}`
          : 'No ChatGPT account connected.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!status?.connected || !status.planEnabled ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('sign-in', async () => {
                await invoke('CHATGPT_SIGN_IN');
                await refresh();
              })
            }
            className={`${buttonClass} inline-flex items-center gap-2`}
          >
            <img src={chatGPTLogo} alt="" className="h-4 w-4 dark:invert" />
            {busy === 'sign-in'
              ? 'Waiting for browser…'
              : status?.connected
                ? 'Enable ChatGPT plan usage'
                : 'Continue with ChatGPT'}
          </button>
        ) : null}
        {busy === 'sign-in' ? (
          <button
            type="button"
            className={buttonClass}
            onClick={() =>
              void invoke('CHATGPT_CANCEL_SIGN_IN').catch(() =>
                setError(
                  'Could not cancel sign-in. Close the browser sign-in page.',
                ),
              )
            }
          >
            Cancel sign-in
          </button>
        ) : null}
        {status?.connected ? (
          <>
            <button
              type="button"
              disabled={busy !== null}
              className={buttonClass}
              onClick={() =>
                void run('sign-out', async () => {
                  const result = (await invoke('CHATGPT_SIGN_OUT')) as {
                    remoteRevoked: boolean;
                  };
                  await refresh();
                  if (!result.remoteRevoked)
                    setNotice(
                      'Signed out locally. Remote revocation could not be confirmed; disconnect Pluto in ChatGPT settings.',
                    );
                })
              }
            >
              {busy === 'sign-out' ? 'Signing out…' : 'Sign out'}
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                void invoke('CHATGPT_MANAGE_USAGE').catch(() =>
                  setError(
                    'Could not open ChatGPT settings. Visit chatgpt.com/settings/usage.',
                  ),
                )
              }
            >
              Manage usage
            </button>
          </>
        ) : null}
        <button
          type="button"
          disabled={busy !== null}
          className={buttonClass}
          onClick={() => void run('models', refresh)}
        >
          {busy === 'models' ? 'Refreshing…' : 'Refresh connection'}
        </button>
      </div>
      {status?.usageLimited ? (
        <div className="space-y-2">
          <p className="text-[13px] leading-5 text-pro-text-muted">
            ChatGPT requests are paused after a usage limit. Review your
            allowance before retrying.
          </p>
          <button
            type="button"
            className={buttonClass}
            onClick={() =>
              void invoke('CHATGPT_RESUME_USAGE')
                .then(setStatus)
                .catch(() =>
                  setError('Could not resume ChatGPT requests. Try again.'),
                )
            }
          >
            Retry ChatGPT requests
          </button>
        </div>
      ) : null}
      {status?.planEnabled && usage && policy ? (
        <section
          aria-label="ChatGPT usage protection"
          className="space-y-3 border-t border-pro-border pt-4"
        >
          <h4 className="text-[13px] font-medium text-pro-text-main">
            Usage protection
          </h4>
          <p className="text-[13px] leading-5 text-pro-text-muted">
            Today: {usage.requests.toLocaleString()} requests ·{' '}
            {(usage.inputTokens + usage.outputTokens).toLocaleString()} reported
            tokens · {usage.duplicatesAvoided.toLocaleString()} duplicate
            requests avoided. Limits reset at midnight on this Mac. All Pluto
            profiles and apps may share your ChatGPT allowance; these limits
            apply only to this Pluto profile.
          </p>
          {usage.unmeasuredRequests > 0 ? (
            <p className="text-[12px] leading-5 text-pro-text-muted">
              {usage.unmeasuredRequests} pending or unmeasured requests count
              against a reserved estimate, including interrupted requests.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <label className="space-y-1 text-[13px] text-pro-text-main">
              Daily request limit
              <input
                aria-label="Daily ChatGPT request limit"
                type="number"
                min={1}
                max={1000}
                value={policy.dailyRequests}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    dailyRequests: Number(event.target.value),
                  })
                }
                className="block w-32 rounded-lg border border-pro-border bg-pro-bg px-3 py-2"
              />
            </label>
            <label className="space-y-1 text-[13px] text-pro-text-main">
              Daily token budget
              <input
                aria-label="Daily ChatGPT token budget"
                type="number"
                min={1000}
                max={10000000}
                step={1000}
                value={policy.dailyTokens}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    dailyTokens: Number(event.target.value),
                  })
                }
                className="block w-36 rounded-lg border border-pro-border bg-pro-bg px-3 py-2"
              />
            </label>
          </div>
          <p className="text-[12px] leading-5 text-pro-text-muted">
            Pluto checks reported tokens and reserves an estimate before
            sending. A running response can exceed that estimate; this is not a
            hard token cap or your remaining ChatGPT quota.
          </p>
          <label className="flex items-start gap-2 text-[13px] leading-5 text-pro-text-main">
            <input
              type="checkbox"
              checked={policy.backgroundEnabled}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  backgroundEnabled: event.target.checked,
                })
              }
              className="mt-1"
            />
            Allow automatic background enrichment (up to 10 requests a day,
            within the daily budget)
          </label>
          <p className="text-[12px] leading-5 text-pro-text-muted">
            Off by default. Meeting notes and their checks, connected meeting
            data, and requests you make still run. Optional background People
            and Project refreshes wait.
          </p>
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null}
            onClick={() =>
              void run('usage', async () => {
                const updated = await invoke(
                  'CHATGPT_SET_USAGE_POLICY',
                  policy,
                );
                setUsage(updated);
                setPolicy(updated.policy);
                setNotice('Usage protection saved.');
              })
            }
          >
            {busy === 'usage' ? 'Saving…' : 'Save usage protection'}
          </button>
          <details className="text-[12px] text-pro-text-muted">
            <summary>Usage by task</summary>
            <ul className="mt-2 space-y-1">
              {Object.entries(usage.tasks).map(([task, totals]) => (
                <li key={task}>
                  {task}: {totals.requests} requests ·{' '}
                  {totals.inputTokens.toLocaleString()} input /{' '}
                  {totals.outputTokens.toLocaleString()} output tokens ·{' '}
                  {totals.failed} failed
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
      {status?.planEnabled ? (
        <div className="space-y-1.5">
          <label
            htmlFor="chatgpt-model"
            className="block text-[13px] font-medium text-pro-text-main"
          >
            Model
          </label>
          <select
            id="chatgpt-model"
            value={model}
            disabled={busy !== null || models.length === 0}
            onChange={(event) => {
              const selected = event.target.value;
              void invoke('SET_SETTING', {
                key: 'chatgpt_model',
                value: selected,
              })
                .then(() => setModel(selected))
                .catch(() =>
                  setError('Could not save the ChatGPT model. Try again.'),
                );
            }}
            className="w-full rounded-lg border border-pro-border bg-pro-bg px-3 py-2.5 text-[13px] text-pro-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent"
          >
            {!models.some((available) => available.id === model) ? (
              <option value="">Choose a model</option>
            ) : null}
            {models.map((available) => (
              <option key={available.id} value={available.id}>
                {available.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-[13px] leading-5 text-pro-text-muted">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] leading-5 text-red-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}
