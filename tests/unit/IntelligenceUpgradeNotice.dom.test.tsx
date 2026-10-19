// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntelligenceUpgradeNotice } from '../../src/components/features/IntelligenceUpgradeNotice';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.innerHTML = '';
});

async function renderNotice(
  saved: Record<string, string>,
  provider: 'ollama' | 'chatgpt' | 'openrouter' = 'ollama',
) {
  const open = vi.fn();
  const invoke = vi.fn(async (channel, input) => {
    if (channel === 'GET_SETTING') return saved[input];
    if (channel === 'SET_SETTING') saved[input.key] = input.value;
  });
  Object.defineProperty(window, 'ipcRenderer', {
    configurable: true,
    value: { invoke },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntelligenceUpgradeNotice provider={provider} onOpenSettings={open} />,
    ),
  );
  return { container, root, invoke, open };
}

describe('Existing-user intelligence notice', () => {
  it.each(['ollama', 'openrouter'] as const)(
    'preserves %s and never signs in or grants cloud access automatically',
    async (provider) => {
      const f = await renderNotice(
        { setup_complete: 'true', llm_provider: provider },
        provider,
      );
      expect(f.container.textContent).toContain(
        'Your current provider stays selected',
      );
      expect(
        f.invoke.mock.calls.every(([channel]) => channel === 'GET_SETTING'),
      ).toBe(true);
      act(() => f.root.unmount());
    },
  );

  it.each(['Keep current setup', 'Review ChatGPT'])(
    'persists %s and never repeats after remount',
    async (action) => {
      const saved = { setup_complete: 'true', llm_provider: 'ollama' };
      const f = await renderNotice(saved);
      await act(async () =>
        [...f.container.querySelectorAll('button')]
          .find((button) => button.textContent === action)!
          .click(),
      );
      expect(f.container.textContent).toBe('');
      expect(f.open).toHaveBeenCalledTimes(action === 'Review ChatGPT' ? 1 : 0);
      expect(saved.llm_provider).toBe('ollama');
      expect(f.invoke).not.toHaveBeenCalledWith(
        'SET_SETTING',
        expect.objectContaining({ key: 'cloud_consent_chatgpt' }),
      );
      act(() => f.root.unmount());
      const next = await renderNotice(saved);
      expect(next.container.textContent).toBe('');
      act(() => next.root.unmount());
    },
  );

  it.each([
    { setup_complete: 'false' },
    { setup_complete: 'true', intelligence_setup_complete: 'true' },
    { setup_complete: 'true', intelligence_upgrade_notice_seen: 'true' },
  ])(
    'does not prompt a new, already-decided, or previously-dismissed profile: %j',
    async (saved) => {
      const f = await renderNotice(saved);
      expect(f.container.textContent).toBe('');
      act(() => f.root.unmount());
    },
  );

  it('does not promote a connection that is already selected', async () => {
    const f = await renderNotice({ setup_complete: 'true' }, 'chatgpt');
    expect(f.container.textContent).toBe('');
    act(() => f.root.unmount());
  });
});
