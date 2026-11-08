import { contextBridge, ipcRenderer } from 'electron';
import type { BusFrame } from '@dali-scout/core';
import { CH, type DaliApi, type SimState, type SourceInfo } from '../shared';

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
  setReplaySpeed: (s) => ipcRenderer.invoke(CH.speed, s),
  listDevices: () => ipcRenderer.invoke(CH.devices),
  connect: (t) => ipcRenderer.invoke(CH.connect, t),
  send: (r) => ipcRenderer.invoke(CH.send, r),
  saveFile: (r) => ipcRenderer.invoke(CH.saveFile, r),
  onSimState(cb) {
    const h = (_: unknown, s: SimState) => cb(s);
    ipcRenderer.on(CH.simState, h);
    return () => ipcRenderer.off(CH.simState, h);
  },
  simCommand: (c) => ipcRenderer.invoke(CH.simCommand, c)
};

contextBridge.exposeInMainWorld('dali', api);
