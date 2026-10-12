// `infrawrench://open/<kind>?org=…` links from outside the app (the VS Code
// and Raycast extensions, a browser). The main process only routes them: the
// renderer parses the link with client-core's `parseDesktopDeepLink` (ESM,
// which this CommonJS graph would have to bridge) and opens the tab.
//
// A link can arrive before any window exists (a cold start from the link on
// macOS, or argv on Windows/Linux), so the latest one is held until the
// renderer asks for it on mount.
import { BrowserWindow, ipcMain } from "electron";
import { PROTOCOL } from "../env";

const OPEN_PREFIX = `${PROTOCOL}://open/`;

let pending: string | null = null;

export function isDeepLink(url: string): boolean {
  return url.startsWith(OPEN_PREFIX);
}

export function deliverDeepLink(url: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isLoading()) {
    pending = url;
    return;
  }
  win.webContents.send("deep_link_open", url);
}

// Windows/Linux cold start: the link is in the first instance's argv.
const fromArgv = process.argv.find(isDeepLink);
if (fromArgv) pending = fromArgv;

ipcMain.handle("deep_link_take_pending", () => {
  const url = pending;
  pending = null;
  return url;
});
