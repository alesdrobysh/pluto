// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { applyUpdate } from '../../src/api/updater';
import { SidebarUpdateBadge } from '../../src/components/layout/SidebarUpdateBadge';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'ipcRenderer');
});

it('reports unavailable updater controls instead of silently succeeding', async () => {
  expect(await applyUpdate()).toEqual({
    started: false,
    error: 'Update controls are unavailable. Restart Pluto and try again.',
  });
});

it('sends Update & Restart through IPC and shows a start failure beside the action', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'PLUTO_UPDATER_GET_STATUS')
      return {
        hasUpdate: true,
        currentVersion: '1.0.0-rc.14',
        latestVersion: 'v1.0.0-rc.15',
        checkedAt: Date.now(),
      };
    if (channel === 'PLUTO_UPDATER_APPLY_UPDATE')
      return { started: false, error: 'Installer unavailable.' };
    return null;
  });
  Object.defineProperty(window, 'ipcRenderer', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}) },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SidebarUpdateBadge />));
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Update & Restart'),
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    expect(invoke).toHaveBeenCalledWith('PLUTO_UPDATER_APPLY_UPDATE');
    expect(container.textContent).toContain('Installer unavailable.');
  } finally {
    act(() => root.unmount());
  }
});
