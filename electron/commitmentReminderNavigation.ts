import { parseActionMetadata } from '../src/utils/actionCommitment';
import type * as DatabaseApi from './db';
export interface CommitmentReminderTarget {
  entityId: string | null;
  meetingId: string | null;
}
interface Renderer {
  isDestroyed(): boolean;
  send(channel: string, target: CommitmentReminderTarget): void;
}
/** Queue the latest click across window recreation and renderer setup, resolving only at delivery. */
export function createCommitmentReminderNavigation(options: {
  getRenderer(): Renderer | null;
  focusWindow(): void;
  resolve(entityId: string): CommitmentReminderTarget;
  onError(error: unknown): void;
}) {
  let readyRenderer: Renderer | null = null;
  let pending: string | null = null;
  const flush = () => {
    const renderer = options.getRenderer();
    if (
      !pending ||
      renderer !== readyRenderer ||
      !renderer ||
      renderer.isDestroyed()
    )
      return;
    try {
      const target = options.resolve(pending);
      renderer.send('COMMITMENT_REMINDER_NAVIGATE', target);
      pending = null;
    } catch (error) {
      options.onError(error);
    }
  };
  return {
    loading(renderer: Renderer) {
      if (readyRenderer === renderer) readyRenderer = null;
    },
    ready(renderer: Renderer) {
      if (renderer !== options.getRenderer() || renderer.isDestroyed()) return;
      readyRenderer = renderer;
      flush();
    },
    click(entityId: string) {
      pending = entityId;
      options.focusWindow();
      flush();
    },
    close() {
      readyRenderer = null;
      pending = null;
    },
  };
}

/** Only verified alias continuity may restore an obsolete notification identity. */
export function resolveCommitmentReminderTarget(
  api: Pick<
    typeof DatabaseApi,
    'commitmentReminderStore' | 'getEntity' | 'isRetiredCommitment'
  >,
  entityId: string,
): CommitmentReminderTarget {
  const canonicalId = api.commitmentReminderStore.resolveObligationId(entityId);
  const entity = canonicalId ? api.getEntity(canonicalId) : undefined;
  if (
    !entity ||
    entity.type !== 'action_item' ||
    api.isRetiredCommitment(entity.id)
  )
    return { entityId: null, meetingId: null };
  const metadata = parseActionMetadata(entity.metadata);
  const sourceId =
    typeof metadata.source_meeting_id === 'string'
      ? metadata.source_meeting_id
      : api.commitmentReminderStore.sourceMeetingId(entity.id);
  return {
    entityId: entity.id,
    meetingId:
      sourceId && api.commitmentReminderStore.sourceExists(sourceId)
        ? sourceId
        : null,
  };
}
