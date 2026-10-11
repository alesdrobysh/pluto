import { expect, it, vi } from 'vitest';
import {
  createCommitmentReminderNavigation,
  resolveCommitmentReminderTarget,
} from '../../electron/commitmentReminderNavigation';
const renderer = () => ({ isDestroyed: vi.fn(() => false), send: vi.fn() });
it('queues while renderer loads and resolves current identity only when ready', () => {
  let current = renderer();
  const resolve = vi.fn(() => ({ entityId: 'current', meetingId: 'source' }));
  const focusWindow = vi.fn();
  const navigation = createCommitmentReminderNavigation({
    getRenderer: () => current,
    focusWindow,
    resolve,
    onError: vi.fn(),
  });
  navigation.click('original');
  expect(focusWindow).toHaveBeenCalledOnce();
  expect(resolve).not.toHaveBeenCalled();
  const prior = current;
  current = renderer();
  navigation.ready(prior);
  expect(resolve).not.toHaveBeenCalled();
  navigation.ready(current);
  expect(resolve).toHaveBeenCalledWith('original');
  expect(current.send).toHaveBeenCalledWith('COMMITMENT_REMINDER_NAVIGATE', {
    entityId: 'current',
    meetingId: 'source',
  });
  navigation.ready(current);
  expect(current.send).toHaveBeenCalledOnce();
});
it('waits through renderer reload and shutdown discards queued clicks', () => {
  const current = renderer();
  const navigation = createCommitmentReminderNavigation({
    getRenderer: () => current,
    focusWindow: vi.fn(),
    resolve: () => ({ entityId: 'a', meetingId: null }),
    onError: vi.fn(),
  });
  navigation.ready(current);
  navigation.loading(current);
  navigation.click('a');
  expect(current.send).not.toHaveBeenCalled();
  navigation.close();
  navigation.ready(current);
  expect(current.send).not.toHaveBeenCalled();
});
it('uses verified canonical identity and refuses retired, missing, or uncertain replacements', () => {
  const api = {
    commitmentReminderStore: {
      resolveObligationId: vi.fn(() => 'canonical'),
      sourceMeetingId: vi.fn(() => 'source'),
      sourceExists: vi.fn(() => true),
    },
    getEntity: vi.fn(() => ({
      id: 'canonical',
      type: 'action_item',
      metadata: null,
    })),
    isRetiredCommitment: vi.fn(() => false),
  };
  const resolve = () =>
    resolveCommitmentReminderTarget(
      api as unknown as Parameters<typeof resolveCommitmentReminderTarget>[0],
      'original',
    );
  expect(resolve()).toEqual({ entityId: 'canonical', meetingId: 'source' });
  api.commitmentReminderStore.sourceExists.mockReturnValue(false);
  expect(resolve()).toEqual({ entityId: 'canonical', meetingId: null });
  api.isRetiredCommitment.mockReturnValue(true);
  expect(resolve()).toEqual({ entityId: null, meetingId: null });
  api.isRetiredCommitment.mockReturnValue(false);
  api.commitmentReminderStore.resolveObligationId.mockReturnValue(
    null as unknown as string,
  );
  expect(resolve()).toEqual({ entityId: null, meetingId: null });
});
