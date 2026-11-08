import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCapture, type BusFrame } from '@dali-scout/core';
import { ReplayTransport, type DaliTransport } from '@dali-scout/transports';
import { CH, type SourceInfo } from '../shared';

let win: BrowserWindow | null = null;
let current: DaliTransport | null = null;
let replay: ReplayTransport | null = null;
let replaySpeed = 1;
let unsubscribe: (() => void)[] = [];

// --- frame batching: never send one IPC message per frame ---------------------------
let pending: BusFrame[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function queueFrame(f: BusFrame): void {
  pending.push(f);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      win?.webContents.send(CH.frames, batch);
    }, 16);
  }
}

function sendSource(s: SourceInfo): void {
  win?.webContents.send(CH.source, s);
}

async function stopSource(): Promise<void> {
  unsubscribe.forEach((u) => u());
  unsubscribe = [];
  const t = current;
  current = null;
  replay = null;
  if (t) await t.close();
}

async function attach(t: DaliTransport, label: string): Promise<void> {
  await stopSource();
  current = t;
  unsubscribe.push(t.onFrame(queueFrame));
  unsubscribe.push(t.onStatus((status, err) => {
    if (t !== current) return;
    if (status === 'closed') sendSource({ state: 'finished', label });
    else if (status === 'error') sendSource({ state: 'error', label, error: err?.message });
  }));
  await t.open();
  sendSource({ state: 'running', label });
}

async function startReplayFile(path: string, label: string): Promise<void> {
  try {
    const frames = parseCapture(await readFile(path, 'utf8'));
    const r = new ReplayTransport(frames, { speed: replaySpeed });
    await attach(r, label);
    replay = r;
  } catch (e) {
    sendSource({ state: 'error', label, error: (e as Error).message });
  }
}

function demoPath(): string {
  // dev: <repo>/examples; packaged builds will bundle it as a resource (milestone 7)
  return app.isPackaged
    ? join(process.resourcesPath, 'examples', 'demo.dscap')
    : join(app.getAppPath(), '..', '..', 'examples', 'demo.dscap');
}

function registerIpc(): void {
  ipcMain.handle(CH.startDemo, () => startReplayFile(demoPath(), 'Demo capture'));
  ipcMain.handle(CH.stop, async () => {
    await stopSource();
    sendSource({ state: 'idle', label: '' });
  });
  ipcMain.handle(CH.speed, (_e, speed: number) => {
    replaySpeed = speed;
    replay?.setSpeed(speed);
  });
  ipcMain.handle(CH.openCapture, async () => {
    if (!win) return;
    const res = await dialog.showOpenDialog(win, {
      title: 'Open capture',
      filters: [{ name: 'DALI Scout capture', extensions: ['dscap'] }],
      properties: ['openFile']
    });
    const file = res.filePaths[0];
    if (!res.canceled && file) await startReplayFile(file, file.split(/[\\/]/).pop() ?? file);
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
app.on('window-all-closed', () => { void stopSource(); if (process.platform !== 'darwin') app.quit(); });
