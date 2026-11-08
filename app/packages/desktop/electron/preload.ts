// Typed preload bridge. The renderer can only invoke channels in INVOKE_CHANNELS
// and only listen to events in EVENT_LITERALS / EVENT_PREFIXES: there is no
// path for a compromised renderer to pass an arbitrary channel name through.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { RPC_CONNECT, RPC_DISCONNECT, RPC_FRAME } from "../shared/rpc/channels";

// Must stay in sync with the ipcMain.handle(...) calls in the electron/ dir.
const INVOKE_CHANNELS = [
  // shell command (`infrawrench` CLI shim)
  // what `infrawrench deploy` did on this machine (local mode's Deploy tab)
  // cloud: none; every cloud call rides the `CloudHttp` RPC (`cloud-transport.ts`)
] as const;

const EVENT_LITERALS = new Set<string>(["update_available_prompt", "update_error"]);

const EVENT_PREFIXES: readonly string[] = [];

function isAllowedEventChannel(channel: string): boolean {
  if (EVENT_LITERALS.has(channel)) return true;
  return EVENT_PREFIXES.some((p) => channel.startsWith(p));
}

// Each method has the channel baked in via closure so the renderer cannot
// invoke a channel name it didn't already have a method for.
const invokeMap: Record<string, (args?: unknown) => Promise<unknown>> = {};
for (const ch of INVOKE_CHANNELS) {
  invokeMap[ch] = (args?: unknown) => ipcRenderer.invoke(ch, args);
}

// The Effect RPC transport (`shared/rpc/channels.ts`): the renderer connects,
// then exchanges JSON frames. Only these channels, so the RPC bridge adds no
// way to reach a handler by name. The token names this page load, so its
// disconnect on `pagehide` can never end the connection of the page that
// replaces it.
// (The main project has no DOM lib; this is the one DOM API the preload uses.)
declare const window: { addEventListener(type: "pagehide", listener: () => void): void };
const rpcPageToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
window.addEventListener("pagehide", () => ipcRenderer.send(RPC_DISCONNECT, rpcPageToken));
const rpcBridge = {
  connect(): void {
    ipcRenderer.send(RPC_CONNECT, rpcPageToken);
  },
  send(frame: string): void {
    if (typeof frame === "string") ipcRenderer.send(RPC_FRAME, frame);
  },
  onFrame(listener: (frame: string) => void): () => void {
    const handler = (_event: IpcRendererEvent, frame: unknown) => {
      if (typeof frame === "string") listener(frame);
    };
    ipcRenderer.on(RPC_FRAME, handler);
    return () => {
      ipcRenderer.off(RPC_FRAME, handler);
    };
  },
};

contextBridge.exposeInMainWorld("electronAPI", {
  ...invokeMap,
  rpc: rpcBridge,

  on(channel: string, callback: (...args: unknown[]) => void): void {
    if (!isAllowedEventChannel(channel)) {
      throw new Error(`electronAPI.on: refused unknown channel "${channel}"`);
    }
    ipcRenderer.on(channel, (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args));
  },

  offAll(channel: string): void {
    if (!isAllowedEventChannel(channel)) return;
    ipcRenderer.removeAllListeners(channel);
  },
});

export type {};
