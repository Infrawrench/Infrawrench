/**
 * The app shell's main-process side (`AppShellRpcs`), and the state it shares
 * with `main.ts`: how much background work keeps the app alive with its
 * window closed, and the install callback of a staged update.
 */
import { BrowserWindow, Notification, clipboard, dialog, shell } from "electron";
import { Context, Effect, Layer } from "effect";
import {
  ExternalUrlRefused,
  type ClipboardImage,
  type OpenDialogOptions,
  type OpenDialogResult,
} from "../shared/rpc/groups/app-shell";
import { registerDialogBlessedPath } from "./main-utils";

// While > 0, closing the last window hides it instead of quitting so the
// renderer's polling loop keeps firing notifications in the background.
let activePingCount = 0;
let activeCronCount = 0;

/** Whether background work (metric pings or enabled crons) should keep the app alive. */
export function hasBackgroundWork(): boolean {
  return activePingCount > 0 || activeCronCount > 0;
}

// Set once the update is staged and installable; `before-quit` then calls it
// so the update actually applies on exit (see `startAutoUpdater` in main.ts).
let pendingUpdateInstall: (() => void) | null = null;

export function setPendingUpdateInstall(install: (() => void) | null): void {
  pendingUpdateInstall = install;
}

export function getPendingUpdateInstall(): (() => void) | null {
  return pendingUpdateInstall;
}

const activeCount = (count: number) => Math.max(0, Math.floor(count));

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });
  n.show();
}

async function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult> {
  const win = BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (!result.canceled) {
    for (const p of result.filePaths ?? []) registerDialogBlessedPath(p);
  }
  return { canceled: result.canceled, filePaths: result.filePaths ?? [] };
}

const EXTERNAL_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const openExternalUrl = Effect.fn("AppShell.openExternalUrl")(function* (url: string) {
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => new ExternalUrlRefused({ message: "open_external_url: invalid URL" }),
  });
  if (!EXTERNAL_URL_SCHEMES.has(parsed.protocol)) {
    return yield* new ExternalUrlRefused({
      message: `open_external_url: scheme "${parsed.protocol}" is not permitted`,
    });
  }
  yield* Effect.promise(() => shell.openExternal(parsed.toString()));
});

function readClipboardImage(): ClipboardImage | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  return { pngBase64: image.toPNG().toString("base64"), mime: "image/png" };
}

export class AppShell extends Context.Service<
  AppShell,
  {
    readonly setPingsActive: (count: number) => Effect.Effect<void>;
    readonly setCronsActive: (count: number) => Effect.Effect<void>;
    readonly installUpdateNow: Effect.Effect<void>;
    readonly showNotification: (title: string, body: string) => Effect.Effect<void>;
    readonly showOpenDialog: (options: OpenDialogOptions) => Effect.Effect<OpenDialogResult>;
    readonly openExternalUrl: (url: string) => Effect.Effect<void, ExternalUrlRefused>;
    readonly readClipboardImage: Effect.Effect<ClipboardImage | null>;
  }
>()("infrawrench/desktop/AppShell") {
  static readonly layer = Layer.succeed(AppShell)(
    AppShell.of({
      setPingsActive: (count) =>
        Effect.sync(() => {
          activePingCount = activeCount(count);
        }),
      setCronsActive: (count) =>
        Effect.sync(() => {
          activeCronCount = activeCount(count);
        }),
      // Deliberately kept set: if the install doesn't take, `before-quit`
      // still has a way to apply it, which clearing it here used to throw away.
      installUpdateNow: Effect.sync(() => pendingUpdateInstall?.()),
      showNotification: (title, body) => Effect.sync(() => showNotification(title, body)),
      showOpenDialog: (options) => Effect.promise(() => showOpenDialog(options)),
      openExternalUrl,
      readClipboardImage: Effect.sync(readClipboardImage),
    }),
  );
}
