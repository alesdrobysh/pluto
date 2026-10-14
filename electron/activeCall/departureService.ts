import { randomUUID } from 'node:crypto';
import { type WebContents, ipcMain, shell } from 'electron';
import {
  ACCEPTED_DEPARTURE_LAYOUTS,
  inspectDeparture,
  providerForBundle,
  safeLayout,
} from './departureAdapters';
import {
  ChromeTabClosureTracker,
  type ChromeTabSnapshot,
  inspectChromeTabs,
} from './chromeTabClosure';
import { DepartureCoordinator } from './departureCoordinator';
import { type DepartureSession, DEPARTURE_IPC as IPC } from './departureTypes';
import { NativeCallMonitor } from './nativeCallMonitor';

export function registerDepartureService(deps: {
  executable: () => string;
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => unknown;
  requireRecordingOwner: (meetingId: string, ownerId: number) => unknown;
  requireCaptureStartOwner: (meetingId: string, ownerId: number) => unknown;
  log: (event: { reason_code: string; app_name?: string }) => void;
  inspectBrowserTabs?: () => Promise<ChromeTabSnapshot>;
  /** Enabled only after tab-specific joined identity passes packaged acceptance. */
  chromeTabClosureAccepted?: () => boolean;
  getCalendarEvent?: (meetingId: string) => {
    start: string;
    end: string;
    isAllDay: boolean;
    isCancelled: boolean;
  } | null;
  onCalendarCheck?: (session: DepartureSession, active: boolean) => boolean;
  isCalendarCheckVisible?: () => boolean;
}) {
  let current: {
    coordinator: DepartureCoordinator;
    monitor: NativeCallMonitor;
    owner: WebContents;
    timer: ReturnType<typeof setInterval>;
    inspecting: boolean;
    tabInspecting: boolean;
    tabTracker: ChromeTabClosureTracker;
    chromeAudioObserved: boolean;
    calendarCheckShown: boolean;
    calendarCheckStartedAt: number | null;
    startedAt: number;
    lastDiagnosticCode: string | null;
    diagnosticCount: number;
  } | null = null;
  const diagnostic = (code: string) => {
    if (!current || current.diagnosticCount >= 24 || current.lastDiagnosticCode === code) return;
    current.lastDiagnosticCode = code;
    current.diagnosticCount++;
    deps.log({ reason_code: `departure_probe:${code}` });
  };
  const enabled = () =>
    process.platform === 'darwin' &&
    deps.getSetting('auto_end_enabled') !== 'false' &&
    deps.getSetting('confirmed_departure_enabled') !== 'false';
  const publish = () => {
    if (current && !current.owner.isDestroyed())
      current.owner.send(
        IPC.status,
        structuredClone(current.coordinator.status),
      );
  };
  const stop = () => {
    if (!current) return;
    if (current.calendarCheckShown)
      deps.onCalendarCheck?.(current.coordinator.status, false);
    clearInterval(current.timer);
    current.monitor.stop();
    current = null;
  };
  const owned = (owner: WebContents, session: DepartureSession) => {
    if (
      !session ||
      typeof session.meetingId !== 'string' ||
      typeof session.generation !== 'string' ||
      current?.owner.id !== owner.id ||
      !current.coordinator.matches(session)
    )
      return null;
    return current;
  };
  ipcMain.handle(IPC.begin, (event, meetingId: unknown) => {
    if (!enabled() || typeof meetingId !== 'string') return null;
    if (
      current?.coordinator.status.meetingId === meetingId &&
      current.owner.id === event.sender.id
    ) {
      deps.requireRecordingOwner(meetingId, event.sender.id);
      return structuredClone(current.coordinator.status);
    }
    deps.requireCaptureStartOwner(meetingId, event.sender.id);
    stop();
    const coordinator = new DepartureCoordinator({
      meetingId,
      generation: randomUUID(),
    });
    const tabTracker = new ChromeTabClosureTracker();
    const monitor = new NativeCallMonitor(
      deps.executable(),
      (snapshot) => {
        if (current?.coordinator !== coordinator) return;
        const revision = coordinator.revision();
        coordinator.observe(snapshot);
        if (coordinator.status.source && coordinator.revision() !== revision)
          diagnostic('source_bound');
        if (coordinator.revision() !== revision) {
          tabTracker.reset();
          current!.chromeAudioObserved = false;
        }
        if (coordinator.status.sessionAmbiguous) {
          tabTracker.reset();
          current!.chromeAudioObserved = false;
        }
        const source = coordinator.status.source;
        if (
          source?.bundleId === 'com.google.Chrome' &&
          (source.input === true || source.output === true)
        ) current!.chromeAudioObserved = true;
        publish();
      },
      () => {
        if (current?.coordinator === coordinator) {
          coordinator.invalidate();
          tabTracker.reset();
          current.chromeAudioObserved = false;
          publish();
        }
      },
    );
    const timer = setInterval(() => {
      const active = current;
      if (!active || active.coordinator !== coordinator) return;
      if (!enabled() || active.owner.isDestroyed()) {
        stop();
        return;
      }
      let calendar: ReturnType<NonNullable<typeof deps.getCalendarEvent>> = null;
      try {
        calendar = deps.getCalendarEvent?.(meetingId) ?? null;
      } catch {
        diagnostic('calendar_read_unavailable');
      }
      const start = calendar ? Date.parse(calendar.start) : Number.NaN;
      const end = calendar ? Date.parse(calendar.end) : Number.NaN;
      coordinator.setCalendarEnd(
        calendar && !calendar.isAllDay && !calendar.isCancelled &&
          Number.isFinite(start) && Number.isFinite(end) &&
          start <= active.startedAt + 15 * 60_000 &&
          end > active.startedAt && end > start &&
          end - start <= 8 * 60 * 60_000
          ? end
          : null,
      );
      coordinator.tick();
      const checkShown = coordinator.status.calendarCheck !== null;
      if (checkShown !== active.calendarCheckShown) {
        active.calendarCheckShown = checkShown;
        active.calendarCheckStartedAt = checkShown ? performance.now() : null;
        try {
          if (deps.onCalendarCheck?.(coordinator.status, checkShown) !== true && checkShown) {
            coordinator.keepRecording();
            active.calendarCheckShown = false;
            diagnostic('calendar_warning_unavailable');
          }
        } catch {
          if (checkShown) {
            coordinator.keepRecording();
            active.calendarCheckShown = false;
            diagnostic('calendar_warning_unavailable');
          }
        }
      }
      if (
        active.calendarCheckShown &&
        active.calendarCheckStartedAt !== null &&
        performance.now() - active.calendarCheckStartedAt >= 3_000 &&
        deps.isCalendarCheckVisible?.() === false
      ) {
        coordinator.keepRecording();
        active.calendarCheckShown = false;
        active.calendarCheckStartedAt = null;
        deps.onCalendarCheck?.(coordinator.status, false);
        diagnostic('calendar_warning_not_visible');
      }
      publish();
      const source = coordinator.status.source;
      if (!source) return;
      const browserTrackingEnabled =
        source.bundleId === 'com.google.Chrome' &&
        deps.getSetting('browser_call_detection_enabled') === 'true' &&
        deps.chromeTabClosureAccepted?.() === true;
      if (!browserTrackingEnabled) {
        tabTracker.reset();
        active.chromeAudioObserved = false;
      }
      else if (!active.tabInspecting && !coordinator.status.stop) {
        active.tabInspecting = true;
        const revision = coordinator.revision();
        void (deps.inspectBrowserTabs ?? inspectChromeTabs)()
          .then((snapshot) => {
            if (
              current !== active ||
              coordinator.revision() !== revision ||
              coordinator.status.source?.id !== source.id ||
              deps.getSetting('browser_call_detection_enabled') !== 'true' ||
              deps.chromeTabClosureAccepted?.() !== true
            )
              return;
            const observation = tabTracker.observe(
                snapshot,
                source.id,
                performance.now(),
                active.chromeAudioObserved,
              );
            if (!snapshot.healthy) diagnostic('browser_inspection_unavailable');
            if (observation === 'bound') diagnostic('meet_tab_bound');
            if (observation === 'closed') {
              diagnostic('meet_tab_closed');
              coordinator.requestStop('tab_closed');
              publish();
            }
          })
          .catch(() => tabTracker.resetPending())
          .finally(() => {
            active.tabInspecting = false;
          });
      }
      const consent =
        deps.getSetting('call_departure_accessibility_enabled') === 'true';
      if (!consent) {
        coordinator.status.inspection = 'off';
        return;
      }
      const accepted = ACCEPTED_DEPARTURE_LAYOUTS.some(
        (profile) =>
          profile.provider === providerForBundle(source.bundleId) &&
          profile.appVersion === source.version &&
          safeLayout(profile),
      );
      coordinator.status.inspection = accepted
        ? 'ready'
        : 'awaiting_acceptance';
      if (
        !accepted ||
        active.inspecting ||
        !coordinator.inspectionDue()
      )
        return;
      active.inspecting = true;
      const revision = coordinator.revision();
      void monitor
        .inspect(source.id)
        .then((snapshot) => {
          if (current !== active || coordinator.revision() !== revision) return;
          if (!snapshot?.healthy || !snapshot.trusted)
            coordinator.status.inspection = 'unavailable';
          if (snapshot?.trusted === false)
            diagnostic('accessibility_permission_denied');
          else if (!snapshot?.healthy)
            diagnostic('accessibility_inspection_unavailable');
          coordinator.inspect(
            snapshot ? inspectDeparture(source, snapshot) : [],
          );
          publish();
        })
        .finally(() => {
          active.inspecting = false;
        });
    }, 1000);
    current = {
      coordinator,
      monitor,
      owner: event.sender,
      timer,
      inspecting: false,
      tabInspecting: false,
      tabTracker,
      chromeAudioObserved: false,
      calendarCheckShown: false,
      calendarCheckStartedAt: null,
      startedAt: Date.now(),
      lastDiagnosticCode: null,
      diagnosticCount: 0,
    };
    event.sender.once('destroyed', () => {
      if (current?.coordinator === coordinator) stop();
    });
    monitor.start();
    return structuredClone(coordinator.status);
  });
  ipcMain.handle(IPC.end, (event, session: DepartureSession) => {
    if (owned(event.sender, session)) stop();
  });
  ipcMain.handle(
    IPC.select,
    (event, session: DepartureSession, sourceId: string) => {
      const active = owned(event.sender, session);
      const result = active?.coordinator.select(sourceId) ?? false;
      publish();
      return result;
    },
  );
  ipcMain.handle(IPC.keep, (event, session: DepartureSession) => {
    owned(event.sender, session)?.coordinator.keepRecording();
    publish();
  });
  ipcMain.handle(IPC.endMeeting, (event, session: DepartureSession) => {
    const active = owned(event.sender, session);
    active?.coordinator.requestStop(
      active.coordinator.status.calendarCheck
        ? 'calendar_user_confirmed'
        : 'user_confirmed',
    );
    publish();
  });
  ipcMain.handle(
    IPC.claim,
    (event, session: DepartureSession, requestId: string) => {
      const active = owned(event.sender, session);
      if (!active || !enabled()) return false;
      deps.requireRecordingOwner(session.meetingId, event.sender.id);
      return active.coordinator.claim(requestId);
    },
  );
  ipcMain.handle(
    IPC.acknowledge,
    (
      event,
      session: DepartureSession,
      requestId: string,
      released: boolean,
    ) => {
      const active = owned(event.sender, session);
      if (!active || typeof released !== 'boolean') return false;
      const request = active.coordinator.status.stop;
      if (!active.coordinator.acknowledge(requestId, released)) return false;
      if (released) {
        deps.log({
          reason_code: `auto_end_completed:${request?.reason}`,
          app_name: request?.appName ?? undefined,
        });
        active.monitor.stop();
        clearInterval(active.timer);
      }
      publish();
      return true;
    },
  );
  ipcMain.handle(
    IPC.preferences,
    async (_event, action?: 'enable' | 'disable' | 'open') => {
      if (action === 'enable' || action === 'disable') {
        deps.setSetting(
          'call_departure_accessibility_enabled',
          String(action === 'enable'),
        );
        // Consent changes discard in-flight confirmation, but the same helper
        // and bound window identity remain intact.
        current?.coordinator.invalidate(true);
      }
      if (action === 'open' && process.platform === 'darwin')
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        );
      return {
        enabled:
          deps.getSetting('call_departure_accessibility_enabled') === 'true',
        acceptedProviders: [
          ...new Set(ACCEPTED_DEPARTURE_LAYOUTS.map((item) => item.provider)),
        ],
      };
    },
  );
  return {
    stop,
    keepCalendarCheck: (session: DepartureSession) => {
      if (!current?.coordinator.matches(session) || !current.calendarCheckShown)
        return false;
      current.coordinator.keepRecording();
      current.calendarCheckShown = false;
      deps.onCalendarCheck?.(session, false);
      publish();
      return true;
    },
    endCalendarCheck: (session: DepartureSession) => {
      if (!current?.coordinator.matches(session) || !current.calendarCheckShown)
        return false;
      current.coordinator.requestStop('calendar_user_confirmed');
      current.calendarCheckShown = false;
      deps.onCalendarCheck?.(session, false);
      publish();
      return true;
    },
    invalidate: () => {
      current?.coordinator.invalidate();
      current?.tabTracker.reset();
      if (current) current.chromeAudioObserved = false;
      publish();
    },
  };
}
