import { contextBridge, ipcRenderer } from 'electron';
import type { BusFrame } from '@dali-scout/core';
import { CH, type DaliApi, type SourceInfo } from '../shared';

const api: DaliApi = {
  onFrames(cb) {
    const h = (_: unknown, frames: BusFrame[]) => cb(frames);
    ipcRenderer.on(CH.frames, h);
    return () => ipcRenderer.off(CH.frames, h);
  },
  onSource(cb) {
    const h = (_: unknown, s: SourceInfo) => cb(s);
    ipcRenderer.on(CH.source, h);
    return () => ipcRenderer.off(CH.source, h);
  },
  openCapture: () => ipcRenderer.invoke(CH.openCapture),
  startDemo: () => ipcRenderer.invoke(CH.startDemo),
  stop: () => ipcRenderer.invoke(CH.stop),
  setReplaySpeed: (s) => ipcRenderer.invoke(CH.speed, s)
};

contextBridge.exposeInMainWorld('dali', api);
