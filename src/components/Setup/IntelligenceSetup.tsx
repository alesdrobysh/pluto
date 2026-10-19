import { useEffect, useRef, useState } from 'react';
import type { ChatGPTStatus } from '../../../electron/chatgpt/types';
import { CLOUD_CONSENT_VERSION } from '../../../electron/llm/providerCatalog';
import chatGPTLogo from '../../assets/brand/chatgpt.svg';
import { ChatGPTPlanWelcome } from '../features/ChatGPTPlanWelcome';

export function IntelligenceSetup({ onComplete }: { onComplete: () => void }) {
  const [provider, setProvider] = useState<'ollama' | 'chatgpt' | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState('');
  const [showWelcome, setShowWelcome] = useState(false);
  const signInAttempt = useRef(0);
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

  const finishSetup = async (choice: 'ollama' | 'chatgpt') => {
    setBusy(true);
    setError('');
    setShowWelcome(false);
    try {
      if (choice === 'chatgpt') {
        await invoke('SET_SETTING', {
          key: 'cloud_consent_chatgpt',
          value: CLOUD_CONSENT_VERSION,
        });
      }
      await invoke('SET_SETTING', { key: 'llm_provider', value: choice });
      await invoke('SET_SETTING', {
        key: 'intelligence_setup_complete',
        value: 'true',
      });
      await invoke('SET_SETTING', { key: 'setup_step', value: '3' });
      onComplete();
    } catch {
      setError('Could not save your choice. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const continueSetup = async () => {
    if (!provider) return;
    if (provider === 'ollama') {
      await finishSetup(provider);
      return;
    }
    if (connected) {
      setShowWelcome(true);
      return;
    }
    const attempt = ++signInAttempt.current;
    setBusy(true);
    setError('');
    try {
      const status = (await invoke('CHATGPT_SIGN_IN')) as ChatGPTStatus;
      if (attempt !== signInAttempt.current) return;
      const model = await invoke('GET_SETTING', 'chatgpt_model');
      if (attempt !== signInAttempt.current) return;
      if (!status?.planEnabled || typeof model !== 'string' || !model.trim()) {
        setError(
          'Allow ChatGPT plan usage in the browser to continue. You can also choose Ollama to keep intelligence local.',
        );
        return;
      }
      setConnected(true);
      setShowWelcome(true);
    } catch {
      if (attempt === signInAttempt.current)
        setError('Sign-in did not finish. Try again, or choose Ollama.');
    } finally {
      if (attempt === signInAttempt.current) setBusy(false);
    }
  };

  const cancelSignIn = async () => {
    ++signInAttempt.current;
    setCanceling(true);
    setError('');
    try {
      await invoke('CHATGPT_CANCEL_SIGN_IN');
    } catch {
      setError(
        'Close the browser sign-in page to cancel. You can still choose Ollama.',
      );
    } finally {
      setCanceling(false);
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-xl">
      <h2 className="font-serif text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] sm:text-[2.25rem]">
        Choose your intelligence
      </h2>
      <p className="mt-3 text-[15px] leading-6 text-pro-text-main/75">
        Get useful meeting notes and answers with the intelligence you prefer.
        Recording and transcription stay on this Mac either way.
      </p>
      <fieldset
        disabled={busy || showWelcome}
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
            <span className="mt-1 block text-[13px] leading-5 text-pro-text-main/75">
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
            <span className="mt-1 block text-[13px] leading-5 text-pro-text-main/75">
              Use an eligible ChatGPT Plus or Pro plan. No Ollama or API key
              needed. Requests count toward your plan allowance.
            </span>
          </span>
        </label>
      </fieldset>
      {provider === 'chatgpt' ? (
        <p className="mt-4 text-[13px] leading-5 text-pro-text-main/75">
          Relevant transcript text, notes, questions, and context are sent to
          OpenAI, including for automatic People and Project updates. Your
          recordings and transcription stay on this Mac.
        </p>
      ) : null}
      {provider === 'chatgpt' ? (
        <p className="mt-3 text-[13px] leading-5 text-pro-text-main/75">
          By default, Pluto allows up to 50 requests a day, including up to 10
          for automatic updates. It pauses at your limit; you can adjust it in
          Settings.
        </p>
      ) : null}
      <p className="mt-4 text-[13px] leading-5 text-pro-text-main/75">
        We’ll remember your choice. You can change it anytime in Settings →
        Intelligence.
      </p>
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!provider || busy || showWelcome}
          onClick={() => void continueSetup()}
          className="inline-flex min-h-12 min-w-48 items-center justify-center gap-2 rounded-lg bg-[oklch(0.25_0.035_258)] px-6 text-sm font-semibold text-[oklch(0.965_0.008_85)] transition-colors hover:bg-[oklch(0.31_0.045_258)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pro-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {provider === 'chatgpt' ? (
            <img src={chatGPTLogo} alt="" className="h-4 w-4 invert" />
          ) : null}
          {busy
            ? provider === 'chatgpt' && !connected
              ? 'Signing in…'
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
            disabled={canceling}
            onClick={() => void cancelSignIn()}
            className="rounded-lg px-3 py-2 text-sm font-medium text-pro-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent"
          >
            {canceling ? 'Canceling…' : 'Cancel sign-in'}
          </button>
        ) : null}
      </div>
      {busy && provider === 'chatgpt' && !connected ? (
        <div
          role="status"
          className="mt-4 text-sm leading-6 text-pro-text-main/75"
        >
          <p className="font-medium text-pro-text-main">
            Finish signing in in your browser
          </p>
          <p>
            Review the request to use your ChatGPT plan, then return to Pluto.
          </p>
        </div>
      ) : null}
      <ChatGPTPlanWelcome
        enabled={showWelcome}
        onContinue={() => void finishSetup('chatgpt')}
      />
      {error ? (
        <p role="alert" className="mt-4 text-sm leading-5 text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
