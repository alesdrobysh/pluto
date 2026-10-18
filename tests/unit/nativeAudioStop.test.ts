import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopNativeAudioProcess } from '../../electron/nativeAudioCapture';

const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
afterEach(() => vi.useRealTimers());

describe('native audio termination', () => {
  it('coalesces requests, waits for close, and clears escalation timers', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const events = vi.fn();
    const pending = stopNativeAudioProcess(child, events);
    expect(stopNativeAudioProcess(child)).toBe(pending);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGINT');
    const settled = vi.fn();
    void pending.then(settled);
    child.emit('exit', 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(pending).resolves.toBe(true);
    expect(events).toHaveBeenLastCalledWith('native_stop_confirmed');
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('waits for transport close when the process has exited but pipes are draining', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    Object.assign(child, {
      exitCode: 0,
      stdout: { readableEnded: false, destroyed: false },
    });
    const settled = vi.fn();
    const pending = stopNativeAudioProcess(child);
    void pending.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(pending).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates only the owned child and retains failure for a retry', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const other = fakeChild();
    const pending = stopNativeAudioProcess(child);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBe(false);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(3, 'SIGKILL');
    expect(other.kill).not.toHaveBeenCalled();
    expect(child.listenerCount('close')).toBe(0);
    const retry = stopNativeAudioProcess(child);
    child.emit('close', null, 'SIGKILL');
    await expect(retry).resolves.toBe(true);
  });

  it('survives signal/diagnostic errors and handles already exited children', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    vi.mocked(child.kill).mockImplementation(() => {
      throw new Error('signal failed');
    });
    const pending = stopNativeAudioProcess(child, () => {
      throw new Error('logging failed');
    });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBe(false);
    const exited = fakeChild();
    Object.assign(exited, { exitCode: 0 });
    await expect(stopNativeAudioProcess(exited)).resolves.toBe(true);
    expect(exited.kill).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')(
  'real child-process shutdown',
  () => {
    it('drains final stdout before acknowledging graceful exit', async () => {
      const child = spawn(process.execPath, [
        '-e',
        `process.on('SIGINT', () => { process.stdout.write('final-frame', () => process.exit(0)); }); process.stdout.write('ready'); setInterval(() => {}, 1000);`,
      ]);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      await once(child.stdout, 'data');
      try {
        await expect(stopNativeAudioProcess(child)).resolves.toBe(true);
        expect(output).toBe('readyfinal-frame');
        expect(child.exitCode).toBe(0);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('kills a child that ignores graceful shutdown', async () => {
      const child = spawn(process.execPath, [
        '-e',
        `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);`,
      ]);
      await once(child.stdout, 'data');
      try {
        await expect(stopNativeAudioProcess(child)).resolves.toBe(true);
        expect(child.signalCode).toBe('SIGKILL');
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('releases 100 consecutive capture children without retained stop listeners', async () => {
      for (let index = 0; index < 100; index += 1) {
        const child = spawn(process.execPath, [
          '-e',
          `process.on('SIGINT', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000);`,
        ]);
        await once(child.stdout, 'data');
        try {
          expect(await stopNativeAudioProcess(child)).toBe(true);
          expect(child.exitCode).toBe(0);
          expect(child.listenerCount('close')).toBe(0);
        } finally {
          child.kill('SIGKILL');
        }
      }
    }, 30_000);
  },
);
