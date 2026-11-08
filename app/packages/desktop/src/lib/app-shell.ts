/**
 * The app shell in the main process (`shared/rpc/groups/app-shell.ts`): the
 * system browser, native notifications, the open dialog, the clipboard image,
 * the background-work counts that keep the app alive with its window closed,
 * and installing a downloaded update.
 */
import type {
  ClipboardImage,
  OpenDialogOptions,
  OpenDialogResult,
} from "../../shared/rpc/groups/app-shell";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/** Open an http(s) or mailto URL in the system browser; anything else is refused. */
export function openExternalUrl(url: string): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.AppOpenExternalUrl({ url })));
}

export function showNotification(title: string, body: string): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.AppShowNotification({ title, body })));
}

/** The folder or files the user picked; every path is then open to the download calls. */
export function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.AppShowOpenDialog(options)));
}

/** The clipboard's image as PNG, or null when it holds none. */
export function readClipboardImage(): Promise<ClipboardImage | null> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.AppReadClipboardImage()));
}

/** How many metric pings are polling; while any are, closing the window hides it. */
export function setPingsActive(count: number): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.AppSetPingsActive({ count })));
}

/** How many crons are enabled; while any are, closing the window hides it. */
export function setCronsActive(count: number): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.AppSetCronsActive({ count })));
}

/** Restart into the downloaded update. */
export function installUpdateNow(): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.AppInstallUpdateNow()));
}
