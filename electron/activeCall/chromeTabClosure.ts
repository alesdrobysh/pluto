import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export type ChromeTabSnapshot = {
  healthy: boolean;
  tabs: { id: string; meetingKey: string | null }[];
};

/** Only a canonical Meet call path becomes an opaque meeting key. */
export function meetKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const code = url.pathname.slice(1).toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'meet.google.com' ||
      !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)
    )
      return null;
    return createHash('sha256').update(code).digest('hex');
  } catch {
    return null;
  }
}

export function parseChromeTabs(output: string): ChromeTabSnapshot {
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (output.length > 131_072 || lines.length > 128)
    return { healthy: false, tabs: [] };
  const seen = new Set<string>();
  const tabs: ChromeTabSnapshot['tabs'] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (
      parts.length !== 3 ||
      !parts[0] ||
      !parts[1] ||
      parts[0].length > 128 ||
      parts[1].length > 128 ||
      seen.has(parts[1])
    )
      return { healthy: false, tabs: [] };
    seen.add(parts[1]);
    tabs.push({ id: parts[1], meetingKey: meetKey(parts[2]) });
  }
  return { healthy: true, tabs };
}

const chromeTabScript = `tell application "Google Chrome"
if it is not running then error "Chrome is not running"
set rows to ""
repeat with w in windows
  set windowID to (id of w) as text
  repeat with t in tabs of w
    set tabID to (id of t) as text
    set tabURL to (URL of t) as text
    set rows to rows & windowID & (ASCII character 9) & tabID & (ASCII character 9) & tabURL & (ASCII character 10)
  end repeat
end repeat
return rows
end tell`;

/** Called only when the user has explicitly enabled browser Automation. */
export function inspectChromeTabs(): Promise<ChromeTabSnapshot> {
  if (process.platform !== 'darwin')
    return Promise.resolve({ healthy: false, tabs: [] });
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', chromeTabScript]);
    let output = '';
    let settled = false;
    const finish = (snapshot: ChromeTabSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(snapshot);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ healthy: false, tabs: [] });
    }, 2_500);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.length > 131_072) {
        child.kill('SIGKILL');
        finish({ healthy: false, tabs: [] });
      }
    });
    // AppleEvents errors can contain user data; never record stderr.
    child.stderr.resume();
    child.on('error', () => finish({ healthy: false, tabs: [] }));
    child.on('close', (code) =>
      finish(
        code === 0 ? parseChromeTabs(output) : { healthy: false, tabs: [] },
      ),
    );
  });
}

/** Exact-tab closure is independent of audio silence and app-level I/O. */
export class ChromeTabClosureTracker {
  private candidate: {
    sourceId: string;
    tabId: string;
    meetingKey: string;
    at: number;
  } | null = null;
  private bound: {
    sourceId: string;
    tabId: string;
    meetingKey: string;
  } | null = null;
  private missingSince: number | null = null;
  private ambiguous = false;

  resetPending() {
    this.missingSince = null;
    this.candidate = null;
  }
  reset() {
    this.resetPending();
    this.bound = null;
    this.ambiguous = false;
  }
  get tracking() {
    return !!this.bound && !this.ambiguous;
  }
  observe(
    snapshot: ChromeTabSnapshot,
    sourceId: string,
    now: number,
    sourceConfirmed = false,
  ): 'bound' | 'closed' | 'unknown' {
    if (!snapshot.healthy) {
      this.resetPending();
      return 'unknown';
    }
    const meetTabs = snapshot.tabs.filter((tab) => tab.meetingKey !== null);
    if (this.bound && this.bound.sourceId !== sourceId) {
      this.reset();
      return 'unknown';
    }
    if (!this.bound) {
      // Chrome activity identifies the likely call app; a sole stable Meet tab
      // supplies the exact closure identity without inspecting its UI.
      if (!sourceConfirmed || meetTabs.length !== 1) {
        this.candidate = null;
        return 'unknown';
      }
      const tab = meetTabs[0];
      if (
        !this.candidate ||
        this.candidate.sourceId !== sourceId ||
        this.candidate.tabId !== tab.id ||
        this.candidate.meetingKey !== tab.meetingKey
      ) {
        this.candidate = {
          sourceId,
          tabId: tab.id,
          meetingKey: tab.meetingKey!,
          at: now,
        };
        return 'unknown';
      }
      if (now - this.candidate.at < 1_000) return 'unknown';
      this.bound = {
        sourceId,
        tabId: tab.id,
        meetingKey: tab.meetingKey!,
      };
      this.candidate = null;
      return 'bound';
    }
    if (this.ambiguous || meetTabs.length > 1) {
      this.ambiguous = true;
      this.missingSince = null;
      return 'unknown';
    }
    const exact = snapshot.tabs.find((tab) => tab.id === this.bound?.tabId);
    if (exact) {
      if (exact.meetingKey !== this.bound.meetingKey) this.ambiguous = true;
      this.missingSince = null;
      return 'unknown';
    }
    // A newly opened Meet page could be a handoff or consecutive call.
    if (meetTabs.length > 0) {
      this.ambiguous = true;
      this.missingSince = null;
      return 'unknown';
    }
    if (this.missingSince === null) {
      this.missingSince = now;
      return 'unknown';
    }
    return now - this.missingSince >= 1_000 ? 'closed' : 'unknown';
  }
}
