/**
 * Wrapper for typed Electron IPC calls.
 *
 * The preload bridge exposes one method per channel — calling
 * `window.electronAPI[channel](args)` invokes only that specific main-process
 * handler. The renderer cannot pass an attacker-chosen channel string.
 *
 * `invoke(channel, args)` is preserved for ergonomic compatibility with the
 * existing call sites; it dispatches into the typed map above. If the channel
 * isn't in the preload allowlist, the call is rejected.
 */
declare global {
  interface Window {
    electronAPI: {
      // Typed per-channel methods are added dynamically by the preload.
      // We index into the bridge to dispatch.
      [channel: string]: ((args?: unknown) => Promise<unknown>) | unknown;
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
  const fn = window.electronAPI[channel];
  if (typeof fn !== "function") {
    return Promise.reject(
      new Error(
        `IPC channel "${channel}" is not exposed by the preload bridge. ` +
          `Add it to electron/preload.ts INVOKE_CHANNELS.`,
      ),
    );
  }
  return fn(args) as Promise<T>;
}
