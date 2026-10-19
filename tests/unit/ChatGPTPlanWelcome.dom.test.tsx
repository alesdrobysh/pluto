// @vitest-environment happy-dom
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTPlanWelcome } from '../../src/components/features/ChatGPTPlanWelcome';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal',
);
let showModal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: showModal,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  if (originalShowModal)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      'showModal',
      originalShowModal,
    );
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
});

function installSettings(saved: Record<string, string> = {}) {
  const invoke = vi.fn(async (channel: string, input?: any) => {
    if (channel === 'GET_SETTING') return saved[input] ?? null;
    if (channel === 'SET_SETTING') saved[input.key] = input.value;
  });
  Object.defineProperty(window, 'ipcRenderer', {
    configurable: true,
    value: { invoke },
  });
  return { invoke, saved };
}

async function mount(enabled = true) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onContinue = vi.fn();
  await act(async () => {
    root.render(
      <ChatGPTPlanWelcome enabled={enabled} onContinue={onContinue} />,
    );
  });
  return { root, container, onContinue };
}

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label,
  )!;
}

describe('ChatGPT plan welcome', () => {
  it('does nothing until enabled', async () => {
    const { invoke } = installSettings();
    const f = await mount(false);
    expect(document.querySelector('dialog')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(f.onContinue).not.toHaveBeenCalled();
  });

  it('opens a native modal outside its parent and persists confirmation across remounts', async () => {
    const { invoke, saved } = installSettings();
    const first = await mount();
    const dialog = document.querySelector('dialog')!;
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(first.container.contains(dialog)).toBe(false);
    expect(dialog.getAttribute('aria-labelledby')).toBe(
      'chatgpt-welcome-title',
    );
    expect(dialog.textContent).toContain(
      'Recording and transcription stay on this Mac',
    );
    expect(first.onContinue).not.toHaveBeenCalled();
    await act(async () => button('Got it').click());
    expect(saved.chatgpt_plan_welcome_seen).toBe('true');
    expect(first.onContinue).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')).toBeNull();
    act(() => first.root.unmount());
    roots.splice(roots.indexOf(first.root), 1);
    const second = await mount();
    expect(second.onContinue).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')).toBeNull();
    expect(showModal).toHaveBeenCalledOnce();
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'SET_SETTING'),
    ).toHaveLength(1);
  });

  it('continues without reopening a confirmation already seen in setup', async () => {
    const { invoke } = installSettings({ chatgpt_plan_welcome_seen: 'true' });
    const f = await mount();
    expect(f.onContinue).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')).toBeNull();
    expect(showModal).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('SET_SETTING', expect.anything());
  });

  it('keeps the dialog open if confirmation cannot be saved and permits retry', async () => {
    const { invoke, saved } = installSettings();
    const original = invoke.getMockImplementation()!;
    let fail = true;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'SET_SETTING' && fail)
        throw new Error('storage unavailable');
      return original(channel, input);
    });
    const f = await mount();
    await act(async () => button('Got it').click());
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save',
    );
    expect(f.onContinue).not.toHaveBeenCalled();
    expect(saved.chatgpt_plan_welcome_seen).toBeUndefined();
    fail = false;
    await act(async () => button('Got it').click());
    expect(f.onContinue).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('acknowledges Escape through the native cancel event before continuing', async () => {
    const { saved } = installSettings();
    const f = await mount();
    const cancel = new Event('cancel', { bubbles: false, cancelable: true });
    await act(async () =>
      document.querySelector('dialog')!.dispatchEvent(cancel),
    );
    expect(cancel.defaultPrevented).toBe(true);
    expect(saved.chatgpt_plan_welcome_seen).toBe('true');
    expect(f.onContinue).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('ignores Escape while saving so acknowledgment cannot run twice', async () => {
    const { invoke } = installSettings();
    const original = invoke.getMockImplementation()!;
    let finishSave!: () => void;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'SET_SETTING')
        return new Promise<void>((resolve) => {
          finishSave = resolve;
        });
      return original(channel, input);
    });
    const f = await mount();
    await act(async () => button('Got it').click());
    expect(button('Saving…').disabled).toBe(true);
    await act(async () =>
      document
        .querySelector('dialog')!
        .dispatchEvent(new Event('cancel', { cancelable: true })),
    );
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'SET_SETTING'),
    ).toHaveLength(1);
    expect(f.onContinue).not.toHaveBeenCalled();
    await act(async () => finishSave());
    expect(f.onContinue).toHaveBeenCalledOnce();
  });

  it('opens plan usage controls without dismissing the confirmation', async () => {
    const { invoke, saved } = installSettings();
    const f = await mount();
    await act(async () => button('Manage usage').click());
    expect(invoke).toHaveBeenCalledWith('CHATGPT_MANAGE_USAGE');
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(saved.chatgpt_plan_welcome_seen).toBeUndefined();
    expect(f.onContinue).not.toHaveBeenCalled();
    invoke.mockRejectedValueOnce(new Error('browser unavailable'));
    await act(async () => button('Manage usage').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not open ChatGPT settings',
    );
    expect(document.querySelector('dialog')?.open).toBe(true);
  });

  it('still asks for acknowledgment if the saved flag cannot be read', async () => {
    const { invoke } = installSettings();
    invoke.mockRejectedValueOnce(new Error('storage unavailable'));
    const f = await mount();
    expect(showModal).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(f.onContinue).not.toHaveBeenCalled();
  });
});
