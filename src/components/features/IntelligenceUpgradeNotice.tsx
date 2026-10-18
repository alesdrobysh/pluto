import { useEffect, useState } from 'react';
import type { ProviderId } from '../../../electron/llm/inferenceTypes';

export function IntelligenceUpgradeNotice({
  provider,
  onOpenSettings,
}: {
  provider: ProviderId;
  onOpenSettings: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const read = (key: string) => window.ipcRenderer.invoke('GET_SETTING', key);
    void Promise.all([
      read('setup_complete'),
      read('intelligence_setup_complete'),
      read('intelligence_upgrade_notice_seen'),
    ])
      .then(([setup, chosen, seen]) => {
        if (active)
          setVisible(setup === 'true' && chosen !== 'true' && seen !== 'true');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const dismiss = async (review: boolean) => {
    setBusy(true);
    setError('');
    try {
      await window.ipcRenderer.invoke('SET_SETTING', {
        key: 'intelligence_upgrade_notice_seen',
        value: 'true',
      });
      setVisible(false);
      if (review) onOpenSettings();
    } catch {
      setError('Could not save your preference. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!visible || provider === 'chatgpt') return null;
  return (
    <aside
      aria-label="ChatGPT intelligence is available"
      className="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-pro-border/60 px-4 py-3 text-[13px] text-pro-text-main"
    >
      <div className="min-w-0 flex-1 basis-64">
        <p className="font-medium">
          You can now use your ChatGPT plan in Pluto.
        </p>
        <p className="mt-1 leading-5 text-pro-text-muted">
          Your current provider stays selected. Recording and transcription stay
          local.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void dismiss(false)}
          className="rounded-md px-3 py-2 font-medium text-pro-text-muted hover:bg-pro-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent disabled:opacity-50"
        >
          Keep current setup
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void dismiss(true)}
          className="rounded-md border border-pro-border px-3 py-2 font-medium hover:bg-pro-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent disabled:opacity-50"
        >
          Review ChatGPT
        </button>
      </div>
      {error ? (
        <p role="alert" className="w-full text-rose-700">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
