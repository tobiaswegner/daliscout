import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCapture } from '@dali-scout/core';
import { CH, type ConnectTarget, type SaveRequest, type SendRequest, type SimCommand } from '../shared';
import { createDeviceTransport, listDevices } from './devices';
import { SourceManager } from './source';

let win: BrowserWindow | null = null;
const source = new SourceManager(() => win);

async function replayFile(path: string, label: string): Promise<void> {
  try {
    await source.startReplay(parseCapture(await readFile(path, 'utf8')), label);
  } catch (e) {
    win?.webContents.send(CH.source, { state: 'error', label, kind: 'replay', error: (e as Error).message });
  }
}

function demoPath(): string {
  // dev: <repo>/examples; packaged builds will bundle it as a resource (milestone 7)
  return app.isPackaged
    ? join(process.resourcesPath, 'examples', 'demo.dscap')
    : join(app.getAppPath(), '..', '..', 'examples', 'demo.dscap');
}

function registerIpc(): void {
  ipcMain.handle(CH.startDemo, () => replayFile(demoPath(), 'Demo capture'));
  ipcMain.handle(CH.stop, () => source.stopAndReport());
  ipcMain.handle(CH.speed, (_e, speed: number) => source.setReplaySpeed(speed));
  ipcMain.handle(CH.devices, () => listDevices());
  ipcMain.handle(CH.send, (_e, req: SendRequest) => source.send(req));
  ipcMain.handle(CH.simCommand, (_e, cmd: SimCommand) => source.simCommand(cmd));

  ipcMain.handle(CH.connect, async (_e, target: ConnectTarget) => {
    if (target.kind === 'virtual') return source.startVirtual();
    try {
      const t = createDeviceTransport(target.id);
      if (target.simulate) await source.startLive(t, target.id);
      else await source.attach(t, target.id, 'device');
    } catch (e) {
      win?.webContents.send(CH.source, { state: 'error', label: target.id, kind: 'device', error: (e as Error).message });
    }
  });

  ipcMain.handle(CH.openCapture, async () => {
    if (!win) return;
    const res = await dialog.showOpenDialog(win, {
      title: 'Open capture',
      filters: [{ name: 'DALI Scout capture', extensions: ['dscap'] }],
      properties: ['openFile']
    });
    const file = res.filePaths[0];
    if (!res.canceled && file) await replayFile(file, file.split(/[\\/]/).pop() ?? file);
  });

  ipcMain.handle(CH.saveFile, async (_e, req: SaveRequest) => {
    if (!win) return { saved: false };
    const res = await dialog.showSaveDialog(win, { defaultPath: req.defaultName, filters: req.filters });
    if (res.canceled || !res.filePath) return { saved: false };
    await writeFile(res.filePath, req.content, 'utf8');
    return { saved: true, path: res.filePath };
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 800, title: 'DALI Scout',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { void source.stop(); if (process.platform !== 'darwin') app.quit(); });
