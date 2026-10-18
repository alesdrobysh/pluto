import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ActivitySnapshot,
  CallSource,
  InspectionSnapshot,
  UiMarker,
} from './departureTypes';

const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object';
const str = (x: unknown): x is string =>
  typeof x === 'string' && x.length <= 1024;
const boolOrNull = (x: unknown) => x === null || typeof x === 'boolean';
const onlyKeys = (x: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(x).every((key) => allowed.includes(key));
function isSource(x: unknown): x is CallSource {
  return (
    object(x) &&
    onlyKeys(x, [
      'id',
      'bundleId',
      'pid',
      'name',
      'version',
      'input',
      'output',
      'audioGeneration',
    ]) &&
    ['id', 'bundleId', 'name', 'version', 'audioGeneration'].every((key) =>
      str(x[key]),
    ) &&
    Number.isInteger(x.pid) &&
    Number(x.pid) > 0 &&
    boolOrNull(x.input) &&
    boolOrNull(x.output)
  );
}
function isMarker(x: unknown): x is UiMarker {
  return (
    object(x) &&
    onlyKeys(x, ['role', 'identifier', 'token']) &&
    str(x.role) &&
    str(x.identifier) &&
    str(x.token)
  );
}
export function parseCallMonitorLine(
  line: string,
): ActivitySnapshot | InspectionSnapshot | null {
  if (line.length > 256_000) return null;
  try {
    const x: unknown = JSON.parse(line);
    if (!object(x) || x.version !== 1 || typeof x.healthy !== 'boolean')
      return null;
    if (
      x.kind === 'activity' &&
      onlyKeys(x, [
        'kind',
        'version',
        'epoch',
        'sequence',
        'healthy',
        'discontinuity',
        'sources',
        'terminated',
      ]) &&
      str(x.epoch) &&
      Number.isInteger(x.sequence) &&
      Number(x.sequence) > 0 &&
      typeof x.discontinuity === 'boolean' &&
      Array.isArray(x.sources) &&
      x.sources.length <= 64 &&
      x.sources.every(isSource) &&
      Array.isArray(x.terminated) &&
      x.terminated.length <= 64 &&
      x.terminated.every(str)
    )
      return x as ActivitySnapshot;
    if (
      x.kind === 'inspection' &&
      onlyKeys(x, [
        'kind',
        'version',
        'requestId',
        'sourceId',
        'healthy',
        'trusted',
        'windows',
      ]) &&
      str(x.requestId) &&
      str(x.sourceId) &&
      typeof x.trusted === 'boolean' &&
      Array.isArray(x.windows) &&
      x.windows.length <= 16 &&
      x.windows.every(
        (w) =>
          object(w) &&
          onlyKeys(w, ['id', 'markers']) &&
          str(w.id) &&
          Array.isArray(w.markers) &&
          w.markers.length <= 1500 &&
          w.markers.every(isMarker),
      )
    )
      return x as InspectionSnapshot;
  } catch {
    /* Unknown data must not look like empty activity. */
  }
  return null;
}

export class NativeCallMonitor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private running = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private lastActivity = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: InspectionSnapshot | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private executable: string,
    private activity: (value: ActivitySnapshot) => void,
    private unknown: () => void,
  ) {}
  start() {
    if (!this.running) {
      this.running = true;
      this.launch();
    }
  }
  private launch() {
    if (!this.running) return;
    this.lastActivity = Date.now();
    const child = spawn(this.executable, ['--monitor-calls'], {
      stdio: 'pipe',
    });
    this.child = child;
    let buffer = '';
    let failed = false;
    const fail = () => {
      if (failed || this.child !== child) return;
      failed = true;
      this.unknown();
      child.kill('SIGKILL');
      this.child = null;
      this.clearPending();
      if (this.watchdog) clearInterval(this.watchdog);
      if (this.running)
        this.retry = setTimeout(
          () => this.launch(),
          [1000, 5000, 15000][this.failures++] ?? 30_000,
        );
    };
    child.on('error', fail);
    child.on('close', fail);
    // Native stderr may contain OS diagnostics. Do not persist AX/meeting data.
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child || failed) return;
      buffer += chunk;
      if (buffer.length > 512_000) {
        fail();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const message = parseCallMonitorLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (!message) {
          fail();
          return;
        }
        if (message.kind === 'activity') {
          this.lastActivity = Date.now();
          this.activity(message);
        } else {
          const pending = this.pending.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            pending.resolve(message);
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > 4000) fail();
    }, 1000);
  }
  inspect(sourceId: string): Promise<InspectionSnapshot | null> {
    const child = this.child;
    if (!child || this.pending.size) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, 2000);
      this.pending.set(requestId, { timer, resolve });
      child.stdin.write(
        `${JSON.stringify({ kind: 'inspect', requestId, sourceId })}\n`,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            resolve(null);
          }
        },
      );
    });
  }
  private clearPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pending.clear();
  }
  stop() {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    this.clearPending();
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      child.kill('SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }, 1500);
      force.unref();
      child.once('close', () => clearTimeout(force));
    }
  }
}
