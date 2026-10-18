import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ available: vi.fn() }));
vi.mock('../../electron/llm/unifiedProvider', () => ({
  UnifiedLLMProvider: class {
    isAvailable = mocks.available;
  },
}));
import { bugReportErrorCode } from '../../electron/bugReports';
import {
  getProvider,
  invalidateProviderCache,
} from '../../electron/llm/factory';

beforeEach(() => {
  invalidateProviderCache();
  mocks.available.mockReset();
});
describe('provider recovery', () => {
  it('reports an unavailable local provider with a safe diagnostic code and retries after restart', async () => {
    mocks.available.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const settings = {
      llm_provider: 'ollama' as const,
      ollama_model: 'fixture',
    };
    const error = await getProvider(settings).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(bugReportErrorCode(error)).toBe('provider_unavailable');
    await expect(getProvider(settings)).resolves.toBeDefined();
    expect(mocks.available).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent initialization without retaining its rejection', async () => {
    mocks.available.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const settings = { llm_provider: 'ollama' as const };
    const results = await Promise.allSettled([
      getProvider(settings),
      getProvider(settings),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(mocks.available).toHaveBeenCalledOnce();
    await expect(getProvider(settings)).resolves.toBeDefined();
    expect(mocks.available).toHaveBeenCalledTimes(2);
  });
});
