import type { SecureSettingsBackend } from '../secureSettings';
import { ChatGPTError } from './auth';

export function createChatGPTStorage(backend: SecureSettingsBackend) {
  return {
    clear(): void {
      const records = { ...backend.readAll() };
      // biome-ignore lint/performance/noDelete: Sign-out must remove the stored credential entirely.
      delete records.chatgpt_session;
      backend.writeAll(records);
    },
    load(): string | null {
      try {
        const encrypted = backend.readAll().chatgpt_session;
        if (!encrypted) return null;
        if (!backend.isAvailable()) throw new Error();
        return backend.decrypt(encrypted);
      } catch {
        throw new ChatGPTError('chatgpt_secure_storage_unavailable');
      }
    },
    save(value: string): void {
      try {
        if (!backend.isAvailable()) throw new Error();
        backend.writeAll({
          ...backend.readAll(),
          chatgpt_session: backend.encrypt(value),
        });
      } catch {
        throw new ChatGPTError('chatgpt_secure_storage_unavailable');
      }
    },
  };
}
