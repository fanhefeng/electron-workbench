import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, ShellCommand, Snapshot } from '../shared/model.ts';

const commandListeners = new Set<(command: ShellCommand) => void>();
const pendingCommands = new Set<ShellCommand>();
const commandHandler = (_event: Electron.IpcRendererEvent, command: ShellCommand) => {
  if (!commandListeners.size) pendingCommands.add(command);
  else commandListeners.forEach((listener) => listener(command));
};
ipcRenderer.on('desktop:command', commandHandler);
window.addEventListener(
  'pagehide',
  () => {
    ipcRenderer.off('desktop:command', commandHandler);
    commandListeners.clear();
    pendingCommands.clear();
  },
  { once: true },
);

const api: DesktopAPI = {
  getSnapshot: () => ipcRenderer.invoke('desktop:getSnapshot'),
  getInfo: () => ipcRenderer.invoke('desktop:getInfo'),
  openTab: (url) => ipcRenderer.invoke('desktop:openTab', url),
  activateTab: (id) => ipcRenderer.invoke('desktop:activateTab', id),
  closeTab: (id) => ipcRenderer.invoke('desktop:closeTab', id),
  reorderTabs: (from, to) => ipcRenderer.invoke('desktop:reorderTabs', from, to),
  navigateTab: (id, url) => ipcRenderer.invoke('desktop:navigateTab', id, url),
  tabAction: (id, action) => ipcRenderer.invoke('desktop:tabAction', id, action),
  setPage: (page) => ipcRenderer.invoke('desktop:setPage', page),
  setViewport: (bounds) => ipcRenderer.invoke('desktop:setViewport', bounds),
  setOverlay: (open) => ipcRenderer.invoke('desktop:setOverlay', open),
  updateSettings: (patch) => ipcRenderer.invoke('desktop:updateSettings', patch),
  nativeAction: (action) => ipcRenderer.invoke('desktop:nativeAction', action),
  showDownload: (id) => ipcRenderer.invoke('desktop:showDownload', id),
  updateAction: (action) => ipcRenderer.invoke('desktop:updateAction', action),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Snapshot) => listener(state);
    ipcRenderer.on('desktop:snapshot', handler);
    return () => {
      ipcRenderer.off('desktop:snapshot', handler);
    };
  },
  onCommand: (listener) => {
    commandListeners.add(listener);
    const pending = [...pendingCommands];
    pendingCommands.clear();
    pending.forEach((command) => listener(command));
    return () => {
      commandListeners.delete(listener);
    };
  },
};
contextBridge.exposeInMainWorld('desktop', api);
