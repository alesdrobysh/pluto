// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntelligenceSetup } from '../../src/components/Setup/IntelligenceSetup';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function renderSetup(
  saved: Record<string, string> = {},
  connection = false,
) {
  const complete = vi.fn();
  let connected = connection;
  const invoke = vi.fn(async (channel: string, input?: any) => {
    if (channel === 'GET_SETTING') return saved[input] ?? null;
    if (channel === 'SET_SETTING') {
      saved[input.key] = input.value;
      return;
    }
    if (channel === 'CHATGPT_STATUS')
      return { connected, planEnabled: connected };
    if (channel === 'OLLAMA_READINESS')
      return { status: 'ready', models: ['custom:local'], missingModels: [] };
    if (channel === 'CHATGPT_SIGN_IN') {
      connected = true;
      saved.chatgpt_model = 'account-model';
      return { connected, planEnabled: connected };
    }
  });
  Object.defineProperty(window, 'ipcRenderer', {
    configurable: true,
    value: { invoke },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<IntelligenceSetup onComplete={complete} />),
  );
  const choose = async (provider: string) =>
    act(async () =>
      container
        .querySelector<HTMLInputElement>(`input[value="${provider}"]`)!
        .click(),
    );
  const submit = async () =>
    act(async () =>
      container
        .querySelector<HTMLButtonElement>('#intelligence-continue')!
        .click(),
    );
  return { container, root, complete, invoke, saved, choose, submit };
}

describe('First-run intelligence choice', () => {
  it('requires a choice and remembers Ollama without requesting cloud access', async () => {
    const f = await renderSetup();
    expect(
      f.container.querySelector<HTMLButtonElement>('button')!.disabled,
    ).toBe(true);
    await f.choose('ollama');
    await f.submit();
    expect(f.saved).toMatchObject({
      llm_provider: 'ollama',
      intelligence_setup_complete: 'true',
      setup_step: '3',
    });
    expect(f.saved.cloud_consent_chatgpt).toBeUndefined();
    expect(f.invoke).not.toHaveBeenCalledWith('CHATGPT_SIGN_IN');
    expect(f.complete).toHaveBeenCalledOnce();
    act(() => f.root.unmount());
  });

  it('explains text sharing, connects ChatGPT once, and persists consent and selection', async () => {
    const f = await renderSetup();
    await f.choose('chatgpt');
    expect(f.container.textContent).toContain(
      'including for background People and Project updates',
    );
    expect(f.container.textContent).toContain('Audio stays local');
    expect(f.container.textContent).toContain('Continue with ChatGPT');
    await f.submit();
    expect(f.invoke).toHaveBeenCalledWith('CHATGPT_SIGN_IN');
    expect(f.saved).toMatchObject({
      llm_provider: 'chatgpt',
      cloud_consent_chatgpt: '1',
      chatgpt_model: 'account-model',
      intelligence_setup_complete: 'true',
      setup_step: '3',
    });
    expect(f.complete).toHaveBeenCalledOnce();
    act(() => f.root.unmount());
  });

  it('reuses an existing ChatGPT connection without asking for sign-in again', async () => {
    const f = await renderSetup(
      { llm_provider: 'chatgpt', chatgpt_model: 'account-model' },
      true,
    );
    expect(f.container.textContent).toContain('Use ChatGPT');
    await f.submit();
    expect(f.invoke).not.toHaveBeenCalledWith('CHATGPT_SIGN_IN');
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.invoke).not.toHaveBeenCalledWith('OLLAMA_READINESS');
    act(() => f.root.unmount());
  });

  it('lets users keep recording while local intelligence is not installed, and remembers their choice', async () => {
    const f = await renderSetup();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (channel, input) =>
      channel === 'OLLAMA_READINESS'
        ? {
            status: 'model_missing',
            models: ['custom:local'],
            missingModels: ['custom:local'],
          }
        : original(channel, input),
    );
    await f.choose('ollama');
    expect(f.container.textContent).toContain('not installed');
    expect(
      f.container.querySelector<HTMLButtonElement>('#intelligence-continue')!
        .disabled,
    ).toBe(true);
    const later = [...f.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Continue with recording',
    )!;
    await act(async () => later.click());
    expect(f.saved).toMatchObject({
      llm_provider: 'ollama',
      intelligence_setup_complete: 'true',
    });
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.invoke).not.toHaveBeenCalledWith('CHATGPT_SIGN_IN');
    act(() => f.root.unmount());
  });

  it('rechecks without changing an existing local model selection', async () => {
    const f = await renderSetup({
      llm_provider: 'ollama',
      ollama_model: 'my-model:latest',
      ollama_fast_model: 'my-quick:latest',
    });
    expect(f.container.textContent).toContain(
      'Your local models are installed',
    );
    const recheck = [...f.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check again',
    )!;
    await act(async () => recheck.click());
    expect(
      f.invoke.mock.calls.filter(([channel]) => channel === 'OLLAMA_READINESS'),
    ).toHaveLength(2);
    await f.submit();
    expect(f.saved.ollama_model).toBe('my-model:latest');
    expect(f.saved.ollama_fast_model).toBe('my-quick:latest');
    act(() => f.root.unmount());
  });

  it('keeps setup open on denied plan access and allows choosing Ollama', async () => {
    const f = await renderSetup();
    f.invoke.mockImplementationOnce(async () => ({
      connected: true,
      planEnabled: false,
    }));
    await f.choose('chatgpt');
    await f.submit();
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Allow ChatGPT plan usage',
    );
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.saved.llm_provider).toBeUndefined();
    await f.choose('ollama');
    await f.submit();
    expect(f.saved.llm_provider).toBe('ollama');
    act(() => f.root.unmount());
  });

  it('does not mark setup complete when persistence fails', async () => {
    const f = await renderSetup();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (channel, input) => {
      if (channel === 'SET_SETTING' && input.key === 'llm_provider')
        throw new Error('Could not save choice');
      return original(channel, input);
    });
    await f.choose('ollama');
    await f.submit();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.saved.intelligence_setup_complete).toBeUndefined();
    expect(f.container.querySelector('[role="alert"]')).toBeTruthy();
    act(() => f.root.unmount());
  });
});
