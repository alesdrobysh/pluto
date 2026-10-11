// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { connectCommitmentReminderNavigation } from '../../src/utils/commitmentReminderNavigation';
let listener: (_event: unknown, payload: unknown) => void;
const unsubscribe = vi.fn();
const invoke = vi.fn();
const on = vi.fn((_channel, callback) => {
  listener = callback;
  return unsubscribe;
});
const callbacks = () => ({
  onOpen: vi.fn(),
  onUnavailable: vi.fn(),
  onError: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(null);
  Object.defineProperty(window, 'ipcRenderer', {
    configurable: true,
    value: { on, invoke },
  });
});
it('waits for renderer/database readiness and installs the listener before announcing readiness', () => {
  const handlers = callbacks();
  connectCommitmentReminderNavigation({ ready: false, ...handlers });
  expect(on).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  const cleanup = connectCommitmentReminderNavigation({
    ready: true,
    ...handlers,
  });
  expect(on).toHaveBeenCalledWith(
    'COMMITMENT_REMINDER_NAVIGATE',
    expect.any(Function),
  );
  expect(invoke).toHaveBeenCalledWith('COMMITMENT_REMINDER_RENDERER_READY');
  expect(on.mock.invocationCallOrder[0]).toBeLessThan(
    invoke.mock.invocationCallOrder[0],
  );
  cleanup();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it('validates the current source meeting before routing to its commitment', async () => {
  const handlers = callbacks();
  invoke.mockImplementation(async (channel) =>
    channel === 'GET_MEETING' ? { id: 'meeting' } : null,
  );
  const cleanup = connectCommitmentReminderNavigation({
    ready: true,
    ...handlers,
  });
  listener(null, { entityId: 'current-commitment', meetingId: 'meeting' });
  await vi.waitFor(() =>
    expect(handlers.onOpen).toHaveBeenCalledWith(
      'current-commitment',
      'meeting',
    ),
  );
  expect(handlers.onUnavailable).not.toHaveBeenCalled();
  cleanup();
});
it('handles a deleted source without opening a stale meeting', async () => {
  const handlers = callbacks();
  const cleanup = connectCommitmentReminderNavigation({
    ready: true,
    ...handlers,
  });
  listener(null, { entityId: 'commitment', meetingId: 'deleted' });
  await vi.waitFor(() =>
    expect(handlers.onUnavailable).toHaveBeenCalledWith('commitment'),
  );
  expect(handlers.onOpen).not.toHaveBeenCalled();
  cleanup();
});
it('does not navigate after the renderer disconnects while source validation is pending', async () => {
  const handlers = callbacks();
  let resolve: (value: unknown) => void = () => {};
  invoke.mockImplementation((channel) =>
    channel === 'GET_MEETING'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve(null),
  );
  const cleanup = connectCommitmentReminderNavigation({
    ready: true,
    ...handlers,
  });
  listener(null, { entityId: 'commitment', meetingId: 'meeting' });
  cleanup();
  resolve({ id: 'meeting' });
  await Promise.resolve();
  expect(handlers.onOpen).not.toHaveBeenCalled();
});
it('handles a deleted or uncertain canonical commitment without opening its old source', async () => {
  const handlers = callbacks();
  const cleanup = connectCommitmentReminderNavigation({
    ready: true,
    ...handlers,
  });
  listener(null, { entityId: null, meetingId: null });
  await vi.waitFor(() =>
    expect(handlers.onUnavailable).toHaveBeenCalledWith(null),
  );
  expect(handlers.onOpen).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith('GET_MEETING', expect.anything());
  cleanup();
});
