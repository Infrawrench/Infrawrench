/**
 * Drop-in replacement for @tauri-apps/api/core's invoke().
 * Calls the Electron main process via contextBridge IPC.
 */
declare global {
  interface Window {
    electronAPI: {
      invoke(channel: string, args?: unknown): Promise<unknown>;
      on(channel: string, callback: (...args: unknown[]) => void): void;
      offAll(channel: string): void;
    };
  }
}

export function invoke<T>(channel: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.electronAPI) {
    return Promise.reject(
      new Error(
        "Electron preload script not loaded — run `pnpm install && pnpm dev` from the desktop package",
      ),
    );
  }
  return window.electronAPI.invoke(channel, args) as Promise<T>;
}
