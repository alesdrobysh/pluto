/** Connect only when setup and database recovery have completed. The main process queues clicks until ready. */
export function connectCommitmentReminderNavigation({
  ready,
  onOpen,
  onUnavailable,
  onError,
}: {
  ready: boolean;
  onOpen: (entityId: string, meetingId: string) => void;
  onUnavailable: (entityId: string | null) => void;
  onError: () => void;
}): () => void {
  if (!ready) return () => {};
  let active = true;
  const unsubscribe = window.ipcRenderer.on(
    'COMMITMENT_REMINDER_NAVIGATE',
    (_event, payload) => {
      const target = payload as { entityId?: unknown; meetingId?: unknown };
      if (
        !target ||
        (target.entityId !== null && typeof target.entityId !== 'string')
      )
        return;
      const entityId = target.entityId;
      const meetingId =
        typeof target.meetingId === 'string' ? target.meetingId : null;
      void (async () => {
        const meeting = meetingId
          ? await window.ipcRenderer.invoke('GET_MEETING', meetingId)
          : null;
        if (!active) return;
        if (meeting && meetingId && entityId) onOpen(entityId, meetingId);
        else onUnavailable(entityId);
      })().catch(() => {
        if (active) onError();
      });
    },
  );
  void window.ipcRenderer
    .invoke('COMMITMENT_REMINDER_RENDERER_READY')
    .catch(() => {
      if (active) onError();
    });
  return () => {
    active = false;
    unsubscribe();
  };
}
