import { useEffect, useState } from 'react';
import type { ChatGPTStatus } from '../../../electron/chatgpt/types';
import { CLOUD_CONSENT_VERSION } from '../../../electron/llm/providerCatalog';
import chatGPTLogo from '../../assets/brand/chatgpt.svg';

export function IntelligenceSetup({ onComplete }: { onComplete: () => void }) {
  const [provider, setProvider] = useState<'ollama' | 'chatgpt' | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invoke = (channel: string, ...args: unknown[]) =>
    window.ipcRenderer.invoke(channel, ...args);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      invoke('GET_SETTING', 'llm_provider'),
      invoke('CHATGPT_STATUS'),
      invoke('GET_SETTING', 'chatgpt_model'),
    ])
      .then(([saved, status, model]) => {
        if (!mounted) return;
        if (saved === 'ollama' || saved === 'chatgpt') setProvider(saved);
        setConnected(
          Boolean(
            (status as ChatGPTStatus | null)?.planEnabled &&
              typeof model === 'string' &&
              model.trim(),
          ),
        );
      })
      .catch(() => {
        if (mounted)
          setError(
            'Could not check your saved choice. Choose how you’d like to continue.',
          );
      });
    return () => {
      mounted = false;
    };
  }, []);

  const continueSetup = async () => {
    if (!provider) return;
    setBusy(true);
    setError('');
    try {
      if (provider === 'chatgpt') {
        if (!connected) {
          const status = (await invoke('CHATGPT_SIGN_IN')) as ChatGPTStatus;
          const model = await invoke('GET_SETTING', 'chatgpt_model');
          if (
            !status?.planEnabled ||
            typeof model !== 'string' ||
            !model.trim()
          ) {
            setError(
              'Allow ChatGPT plan usage to continue, or choose Ollama. An eligible Plus or Pro plan is required.',
            );
            return;
          }
          setConnected(true);
        }
        await invoke('SET_SETTING', {
          key: 'cloud_consent_chatgpt',
          value: CLOUD_CONSENT_VERSION,
        });
      }
      await invoke('SET_SETTING', { key: 'llm_provider', value: provider });
      await invoke('SET_SETTING', {
        key: 'intelligence_setup_complete',
        value: 'true',
      });
      await invoke('SET_SETTING', { key: 'setup_step', value: '3' });
      onComplete();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              '',
            )
          : 'Could not save your choice. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-xl">
      <h2 className="font-serif text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] sm:text-[2.25rem]">
        How should Pluto think?
      </h2>
      <p className="mt-3 text-[15px] leading-6 text-pro-text-muted">
        Choose what powers your notes, answers, and connected knowledge.
        Recording and transcription stay on this Mac either way.
      </p>
      <fieldset
        disabled={busy}
        className="mt-8 divide-y divide-pro-border border-y border-pro-border disabled:opacity-60"
      >
        <legend className="sr-only">Intelligence provider</legend>
        <label className="flex cursor-pointer items-start gap-4 py-5">
          <input
            type="radio"
            name="intelligence-provider"
            value="ollama"
            checked={provider === 'ollama'}
            onChange={() => {
              setProvider('ollama');
              setError('');
            }}
            className="mt-1 h-4 w-4 accent-pro-accent"
          />
          <span>
            <span className="block text-[15px] font-semibold">
              Ollama · On this Mac
            </span>
            <span className="mt-1 block text-[13px] leading-5 text-pro-text-muted">
              Keep intelligence local. No cloud account needed; Ollama must be
              installed and running.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-4 py-5">
          <input
            type="radio"
            name="intelligence-provider"
            value="chatgpt"
            checked={provider === 'chatgpt'}
            onChange={() => {
              setProvider('chatgpt');
              setError('');
            }}
            className="mt-1 h-4 w-4 accent-pro-accent"
          />
          <span>
            <span className="block text-[15px] font-semibold">
              ChatGPT · Your plan
            </span>
            <span className="mt-1 block text-[13px] leading-5 text-pro-text-muted">
              Use an eligible ChatGPT Plus or Pro plan. No Ollama or API key
              needed. Requests count toward your plan allowance.
            </span>
          </span>
        </label>
      </fieldset>
      {provider === 'chatgpt' ? (
        <p className="mt-4 text-[13px] leading-5 text-pro-text-muted">
          By continuing with ChatGPT, you allow relevant transcript text, notes,
          questions, and context to go to OpenAI, including for background
          People and Project updates. Audio stays local.
        </p>
      ) : null}
      <p className="mt-4 text-[13px] leading-5 text-pro-text-muted">
        We’ll remember your choice. You can change it anytime in Settings →
        Intelligence.
      </p>
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!provider || busy}
          onClick={() => void continueSetup()}
          className="inline-flex min-h-12 min-w-48 items-center justify-center gap-2 rounded-lg bg-[oklch(0.25_0.035_258)] px-6 text-sm font-semibold text-[oklch(0.965_0.008_85)] transition-colors hover:bg-[oklch(0.31_0.045_258)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pro-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {provider === 'chatgpt' ? (
            <img src={chatGPTLogo} alt="" className="h-4 w-4 invert" />
          ) : null}
          {busy
            ? provider === 'chatgpt' && !connected
              ? 'Waiting for browser…'
              : 'Saving…'
            : provider === 'chatgpt'
              ? connected
                ? 'Use ChatGPT'
                : 'Continue with ChatGPT'
              : provider === 'ollama'
                ? 'Use Ollama'
                : 'Choose an option'}
        </button>
        {busy && provider === 'chatgpt' && !connected ? (
          <button
            type="button"
            onClick={() =>
              void invoke('CHATGPT_CANCEL_SIGN_IN').catch(() =>
                setError(
                  'Could not cancel sign-in. Close the browser sign-in page.',
                ),
              )
            }
            className="rounded-lg px-3 py-2 text-sm font-medium text-pro-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent"
          >
            Cancel sign-in
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm leading-5 text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
