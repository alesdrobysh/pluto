import { useEffect, useState } from 'react';
import type { OllamaReadiness } from '../../../electron/llm/ollamaReadiness';

const failedReadiness: OllamaReadiness = {
  status: 'check_failed',
  models: [],
  missingModels: [],
};

const isReadiness = (value: unknown): value is OllamaReadiness => {
  if (!value || typeof value !== 'object') return false;
  return (
    'status' in value &&
    typeof value.status === 'string' &&
    ['ready', 'service_unavailable', 'model_missing', 'check_failed'].includes(
      value.status,
    ) &&
    'models' in value &&
    Array.isArray(value.models) &&
    value.models.every((model) => typeof model === 'string' && model.trim()) &&
    'missingModels' in value &&
    Array.isArray(value.missingModels) &&
    value.missingModels.every(
      (model) => typeof model === 'string' && model.trim(),
    ) &&
    (value.status !== 'ready' ||
      (value.models.length > 0 && value.missingModels.length === 0))
  );
};

export function OllamaReadinessStatus({
  onReadiness,
}: {
  onReadiness?: (status: OllamaReadiness | null) => void;
}) {
  const [status, setStatus] = useState<OllamaReadiness | null>(null);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setChecking(true);
    setStatus(null);
    onReadiness?.(null);
    void window.ipcRenderer.invoke('OLLAMA_READINESS').then(
      (value: unknown) => {
        if (!current) return;
        const next = isReadiness(value) ? value : failedReadiness;
        setStatus(next);
        onReadiness?.(next);
        setChecking(false);
      },
      () => {
        if (!current) return;
        const next = failedReadiness;
        setStatus(next);
        onReadiness?.(next);
        setChecking(false);
      },
    );
    return () => {
      current = false;
    };
  }, [revision, onReadiness]);

  const message = checking
    ? 'Checking local intelligence…'
    : status?.status === 'ready'
      ? 'Your local models are installed and Ollama is running.'
      : status?.status === 'service_unavailable'
        ? 'Open Ollama on this Mac, then check again.'
        : status?.status === 'model_missing'
          ? 'Your selected local model is not installed. Install it in Ollama, then check again.'
          : 'Could not verify your local models. Check that Ollama is running, then try again.';
  return (
    <div className="space-y-3 text-[13px] leading-5 text-pro-text-muted">
      <p role="status" aria-live="polite">
        {message}
      </p>
      {status?.status !== 'ready' && !checking ? (
        <>
          <p>
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
              className="text-pro-accent underline underline-offset-2"
            >
              Get or update Ollama
            </a>
            . Recording and transcription remain available while you finish
            local intelligence setup.
          </p>
          {status?.missingModels.map((model) => (
            <p key={model} className="break-all">
              Install{' '}
              <strong className="font-medium text-pro-text-main">
                {model}
              </strong>{' '}
              using Ollama’s model picker or{' '}
              <code>{`ollama pull '${model.replaceAll("'", "'\\''")}'`}</code>{' '}
              in Terminal. This downloads the model to your Mac.
            </p>
          ))}
        </>
      ) : null}
      <button
        type="button"
        disabled={checking}
        onClick={() => setRevision((value) => value + 1)}
        className="rounded-md border border-pro-border px-3 py-2 text-pro-text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-pro-accent disabled:opacity-50"
      >
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
}
