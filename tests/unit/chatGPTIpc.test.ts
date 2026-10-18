import { describe, expect, it, vi } from 'vitest';
import type { ChatGPTAuth } from '../../electron/chatgpt/auth';
import { registerChatGPTHandlers } from '../../electron/chatgpt/ipc';

describe('ChatGPT IPC boundary', () => {
  it('returns display-only status, chooses an available account model, and exposes no token operation', async () => {
    const handlers = new Map<
      string,
      (...args: unknown[]) => Promise<unknown>
    >();
    const status = {
      connected: true,
      planEnabled: true,
      email: 'test@example.test',
    };
    const auth = {
      status: vi.fn(() => status),
      signIn: vi.fn(async () => status),
      models: vi.fn(async () => [
        { id: 'account-model', name: 'Account model' },
      ]),
      signOut: vi.fn(async () => ({ remoteRevoked: true })),
      cancelSignIn: vi.fn(),
      resumeUsage: vi.fn(),
    };
    const settings = { getSetting: vi.fn(), setSetting: vi.fn() };
    const openBrowser = vi.fn(async () => {});
    registerChatGPTHandlers(
      {
        handle: (name, handler) => {
          handlers.set(name, handler as never);
        },
      },
      auth as unknown as ChatGPTAuth,
      settings,
      openBrowser,
    );
    expect(await handlers.get('CHATGPT_SIGN_IN')!()).toEqual(status);
    expect(settings.setSetting).toHaveBeenCalledWith(
      'chatgpt_model',
      'account-model',
    );
    expect(
      [...handlers.keys()].some((key) => /TOKEN|CREDENTIAL/.test(key)),
    ).toBe(false);
    await handlers.get('CHATGPT_MANAGE_USAGE')!();
    expect(openBrowser).toHaveBeenCalledWith(
      'https://chatgpt.com/settings/usage',
    );
  });

  it.each([
    undefined,
    'unavailable-model',
    'gpt-6-luna',
    'gpt-6.1-sol',
    'gpt-5.6-terra',
  ])(
    'prefers Terra for a new connection and preserves an available saved choice: %s',
    async (saved) => {
      const handlers = new Map<string, () => Promise<unknown>>();
      const settings = { getSetting: () => saved, setSetting: vi.fn() };
      registerChatGPTHandlers(
        { handle: (name, handler) => handlers.set(name, handler as never) },
        {
          signIn: async () => ({ planEnabled: true }),
          models: async () => [
            { id: 'gpt-6.1-sol' },
            { id: 'gpt-6-luna' },
            { id: 'gpt-5.6-terra' },
          ],
        } as unknown as ChatGPTAuth,
        settings,
        vi.fn(),
      );
      await handlers.get('CHATGPT_SIGN_IN')!();
      if (saved && saved !== 'unavailable-model')
        expect(settings.setSetting).not.toHaveBeenCalled();
      else
        expect(settings.setSetting).toHaveBeenCalledWith(
          'chatgpt_model',
          'gpt-5.6-terra',
        );
    },
  );

  it('prefers available Sol if Terra is not offered, without removing other account models', async () => {
    const handlers = new Map<string, () => Promise<unknown>>();
    const models = [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }];
    const settings = { getSetting: () => undefined, setSetting: vi.fn() };
    registerChatGPTHandlers(
      { handle: (name, handler) => handlers.set(name, handler as never) },
      {
        signIn: async () => ({ planEnabled: true }),
        models: async () => models,
      } as unknown as ChatGPTAuth,
      settings,
      vi.fn(),
    );
    await handlers.get('CHATGPT_SIGN_IN')!();
    expect(settings.setSetting).toHaveBeenCalledWith(
      'chatgpt_model',
      'gpt-6.1-sol',
    );
    expect(await handlers.get('CHATGPT_MODELS')!()).toEqual(models);
  });

  it('does not fetch models without plan permission and redacts unexpected errors', async () => {
    const handlers = new Map<
      string,
      (...args: unknown[]) => Promise<unknown>
    >();
    const auth = {
      status: vi.fn(() => ({ connected: true, planEnabled: false })),
      signIn: vi.fn(async () => ({ connected: true, planEnabled: false })),
      models: vi.fn(),
      signOut: vi.fn(),
      cancelSignIn: vi.fn(),
      resumeUsage: vi.fn(),
    };
    registerChatGPTHandlers(
      {
        handle: (name, handler) => {
          handlers.set(name, handler as never);
        },
      },
      auth as unknown as ChatGPTAuth,
      { getSetting: vi.fn(), setSetting: vi.fn() },
      vi.fn(),
    );
    await handlers.get('CHATGPT_SIGN_IN')!();
    expect(auth.models).not.toHaveBeenCalled();
    auth.signIn.mockRejectedValueOnce(new Error('fictional-secret-token'));
    await expect(handlers.get('CHATGPT_SIGN_IN')!()).rejects.toThrow(
      'ChatGPT could not complete this request',
    );
  });
});
