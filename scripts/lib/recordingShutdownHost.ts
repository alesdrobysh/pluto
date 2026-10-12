import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';
import { stopNativeAudioProcess } from '../../electron/nativeAudioCapture';

const root = process.env.PLUTO_CAPTURE_TEST_ROOT!;
app.setPath('userData', path.join(root, 'profile'));
void app.whenReady().then(async () => {
  ipcMain.handle('stop-synthetic-child', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGINT', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    );
    await once(child.stdout!, 'data');
    return await stopNativeAudioProcess(child);
  });
  ipcMain.on('shutdown-result', async (_event, result) => {
    await writeFile(path.join(root, 'result.json'), JSON.stringify(result));
    app.exit(result.error ? 1 : 0);
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(root, 'renderer.cjs'),
    },
  });
  await window.loadURL('data:text/html,<title>Isolated shutdown test</title>');
});
