import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type DepartureStatus,
  DEPARTURE_IPC as IPC,
} from '../../electron/activeCall/departureTypes';

type Args = {
  isRecording: boolean;
  meetingId?: string;
  autoEndEnabled: boolean;
  onReopen?: () => void;
  stopSessionRef: MutableRefObject<
    ((endReason?: string) => Promise<boolean>) | null
  >;
};

/** UI bridge only: all evidence decisions and stop authorization live in main. */
export const useAutoEndMonitor = ({
  isRecording,
  meetingId,
  autoEndEnabled,
  onReopen,
  stopSessionRef,
}: Args) => {
  const [departureStatus, setDepartureStatus] =
    useState<DepartureStatus | null>(null);
  const [toast, setToast] = useState<{
    reason: string;
    appName: string | null;
  } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestMeeting = useRef(meetingId);
  latestMeeting.current = meetingId;
  const reopenRef = useRef(onReopen);
  reopenRef.current = onReopen;
  const dismissAutoEndToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setToast(null);
  }, []);

  useEffect(() => {
    if (!window.ipcRenderer) return;
    return window.ipcRenderer.on('MEETING_ENDED_REOPEN', () => {
      dismissAutoEndToast();
      reopenRef.current?.();
    });
  }, [dismissAutoEndToast]);

  useEffect(() => {
    if (!isRecording || !meetingId || !autoEndEnabled || !window.ipcRenderer) {
      setDepartureStatus(null);
      return;
    }
    let cancelled = false;
    let session: DepartureStatus | null = null;
    let executing: string | null = null;
    const end = () => {
      if (session)
        void window.ipcRenderer.invoke(IPC.end, session).catch(() => {});
    };
    const receive = async (status: DepartureStatus) => {
      if (
        cancelled ||
        !status ||
        status.meetingId !== meetingId ||
        (session && status.generation !== session.generation)
      )
        return;
      session = status;
      setDepartureStatus(status);
      const request = status.stop;
      if (!request || executing || status.phase !== 'departure_confirmed')
        return;
      executing = request.requestId;
      try {
        const claimed = await window.ipcRenderer.invoke(
          IPC.claim,
          status,
          request.requestId,
        );
        if (!claimed) return;
        if (cancelled || latestMeeting.current !== meetingId) {
          await window.ipcRenderer.invoke(
            IPC.acknowledge,
            status,
            request.requestId,
            false,
          );
          return;
        }
        let released = false;
        try {
          const endReason = `auto:${request.reason}${request.provider ? `:${request.provider}` : ''}`;
          released = (await stopSessionRef.current?.(endReason)) === true;
        } catch {
          /* Release failure stays retryable. */
        }
        const accepted = await window.ipcRenderer.invoke(
          IPC.acknowledge,
          status,
          request.requestId,
          released,
        );
        if (released && accepted && latestMeeting.current === meetingId) {
          let external = false;
          try {
            external = await window.ipcRenderer.invoke('SHOW_MEETING_ENDED_ALERT', {
              reason: request.reason,
              appName: request.appName,
            }) === true;
          } catch {
            /* Fall back to the in-app notice. */
          }
          if (external) {
            dismissAutoEndToast();
          } else {
            setToast({ reason: request.reason, appName: request.appName });
            if (toastTimer.current) clearTimeout(toastTimer.current);
            toastTimer.current = setTimeout(() => {
              toastTimer.current = null;
              setToast(null);
            }, request.reason === 'calendar_quiet_timeout' || request.reason === 'calendar_user_confirmed' ? 30_000 : 8_000);
          }
        }
      } catch {
        /* Next status retries; never announce an unacknowledged stop. */
      } finally {
        executing = null;
        if (cancelled) end();
      }
    };
    const off = window.ipcRenderer.on(
      IPC.status,
      (_event, status: DepartureStatus) => {
        void receive(status);
      },
    );
    void window.ipcRenderer
      .invoke(IPC.begin, meetingId)
      .then((status: DepartureStatus | null) => {
        if (status && cancelled) {
          session = status;
          end();
        } else if (status) void receive(status);
      })
      .catch(() => setDepartureStatus(null));
    return () => {
      cancelled = true;
      off();
      if (!executing) end();
    };
  }, [isRecording, meetingId, autoEndEnabled, stopSessionRef, dismissAutoEndToast]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const selectSource = (sourceId: string) => {
    if (departureStatus)
      void window.ipcRenderer.invoke(IPC.select, departureStatus, sourceId);
  };
  const keepRecording = () => {
    if (departureStatus)
      void window.ipcRenderer.invoke(IPC.keep, departureStatus);
  };
  const confirmEnd = () => {
    if (departureStatus)
      void window.ipcRenderer.invoke(IPC.endMeeting, departureStatus);
  };
  return {
    departureStatus,
    selectSource,
    keepRecording,
    confirmEnd,
    autoEndTriggered: toast !== null,
    autoEndReason: toast?.reason ?? null,
    autoEndAppName: toast?.appName ?? null,
    dismissAutoEndToast,
  };
};
