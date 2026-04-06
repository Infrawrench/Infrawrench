import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  invoke: (channel: string, args?: unknown) => ipcRenderer.invoke(channel, args),
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
  offAll: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
