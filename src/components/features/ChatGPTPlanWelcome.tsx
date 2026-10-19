import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import chatGPTLogo from '../../assets/brand/chatgpt.svg';

/** Confirm plan use once per Pluto profile, across setup and later sign-ins. */
export function ChatGPTPlanWelcome({
  enabled,
  onContinue,
}: { enabled: boolean; onContinue: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const continuation = useRef(onContinue);
  continuation.current = onContinue;
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void window.ipcRenderer
      .invoke('GET_SETTING', 'chatgpt_plan_welcome_seen')
      .then((seen) => {
        if (!active) return;
        if (seen === 'true') continuation.current();
        else setVisible(true);
      })
      .catch(() => {
        if (active) setVisible(true);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (visible && enabled) dialog.current?.showModal();
  }, [visible, enabled]);

  const acknowledge = async () => {
    setBusy(true);
    setError('');
    try {
      await window.ipcRenderer.invoke('SET_SETTING', {
        key: 'chatgpt_plan_welcome_seen',
        value: 'true',
      });
      setVisible(false);
      continuation.current();
    } catch {
      setError('Could not save this confirmation. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!enabled || !visible) return null;
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="chatgpt-welcome-title"
      aria-describedby="chatgpt-welcome-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) void acknowledge();
      }}
      className="m-auto w-[calc(100%-3rem)] max-w-md rounded-2xl bg-pro-bg p-7 text-pro-text-main shadow-xl backdrop:bg-black/40"
    >
      <img src={chatGPTLogo} alt="" className="mb-5 h-7 w-7 dark:invert" />
      <h2
        id="chatgpt-welcome-title"
        className="font-serif text-2xl leading-tight"
      >
        You’re using your ChatGPT plan
      </h2>
      <p
        id="chatgpt-welcome-description"
        className="mt-3 text-sm leading-6 text-pro-text-main/75"
      >
        Pluto’s notes, answers, and automatic updates count toward your ChatGPT
        allowance. Daily safeguards are already in place. Recording and
        transcription stay on this Mac.
      </p>
      <p className="mt-3 text-sm leading-6 text-pro-text-main/75">
        You can review your plan allowance and adjust access in ChatGPT
        settings.
      </p>
      {error ? (
        <p
          role="alert"
          className="mt-3 text-sm text-rose-700 dark:text-rose-400"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() =>
            void window.ipcRenderer
              .invoke('CHATGPT_MANAGE_USAGE')
              .catch(() =>
                setError('Could not open ChatGPT settings. Please try again.'),
              )
          }
          className="rounded-lg py-2 text-sm font-medium text-pro-accent underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent"
        >
          Manage usage
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void acknowledge()}
          className="rounded-lg bg-pro-accent px-5 py-2.5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pro-accent disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Got it'}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
