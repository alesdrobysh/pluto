import type { IpcMain } from 'electron';
import { invalidateProviderCache } from '../llm/factory';
import { type ChatGPTAuth, chatGPTErrorMessage } from './auth';
import { getChatGPTUsage } from './runtime';
import type { ChatGPTUsagePolicy } from './usage';

export function registerChatGPTHandlers(
  ipc: Pick<IpcMain, 'handle'>,
  auth: ChatGPTAuth,
  settings: {
    getSetting(key: string): unknown;
    setSetting(key: string, value: string): unknown;
  },
  openBrowser: (url: string) => Promise<unknown>,
) {
  const handle = (channel: string, run: () => unknown) =>
    ipc.handle(channel, async () => {
      try {
        return await run();
      } catch (error) {
        throw new Error(chatGPTErrorMessage(error));
      }
    });
  handle('CHATGPT_STATUS', () => ({
    ...auth.status(),
    usageLimited:
      auth.status().usageLimited || getChatGPTUsage().summary().paused,
  }));
  handle('CHATGPT_USAGE', () => getChatGPTUsage().summary());
  ipc.handle(
    'CHATGPT_SET_USAGE_POLICY',
    async (_event, policy: ChatGPTUsagePolicy) => {
      try {
        return getChatGPTUsage().setPolicy(policy);
      } catch (error) {
        throw new Error(chatGPTErrorMessage(error));
      }
    },
  );
  handle('CHATGPT_SIGN_IN', async () => {
    const status = await auth.signIn();
    invalidateProviderCache();
    if (status.planEnabled) {
      const models = await auth.models();
      if (
        !models.some(
          (model) => model.id === settings.getSetting('chatgpt_model'),
        )
      ) {
        const defaultModel =
          models.find((model) => model.id === 'gpt-5.6-terra') ??
          models.find((model) => model.id === 'gpt-6.1-sol') ??
          models[0];
        if (defaultModel) settings.setSetting('chatgpt_model', defaultModel.id);
      }
      invalidateProviderCache();
    }
    return status;
  });
  handle('CHATGPT_CANCEL_SIGN_IN', () => auth.cancelSignIn());
  handle('CHATGPT_MODELS', () => auth.models());
  handle('CHATGPT_SIGN_OUT', async () => {
    const result = await auth.signOut();
    invalidateProviderCache();
    return result;
  });
  handle('CHATGPT_MANAGE_USAGE', () =>
    openBrowser('https://chatgpt.com/settings/usage'),
  );
  handle('CHATGPT_RESUME_USAGE', () => {
    getChatGPTUsage().pause(false);
    auth.resumeUsage();
    return auth.status();
  });
}
