// GUI-side cloud auth wiring: the custom protocol and the single-instance
// lock that route `infrawrench://` URLs to the running app. Imported by
// main.ts for these side effects. The PKCE flow and the RPC service are
// cloud-auth-flow.ts; token storage and refresh are cloud-tokens.ts, which is
// side-effect free and shared with the CLI.
import { app, BrowserWindow } from "electron";
import { setAuthErrorNotifier, getAccessToken, forceRefreshAccessToken } from "./cloud-tokens";
import { PROTOCOL } from "../env";
import { handleOAuthCallback, notifyAuthError } from "./cloud-auth-flow";
import { deliverDeepLink, isDeepLink } from "./deep-links";

export { getAccessToken, forceRefreshAccessToken };

setAuthErrorNotifier(notifyAuthError);

app.setAsDefaultProtocolClient(PROTOCOL);

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Other features that receive `infrawrench://<host>…` links register here by
 * host (e.g. `provider-oauth`). Everything else is the sign-in callback
 * (`infrawrench://callback`), handled below as before.
 */
const protocolRoutes = new Map<string, (url: string) => void | Promise<void>>();

export function registerProtocolRoute(
  host: string,
  handler: (url: string) => void | Promise<void>,
): void {
  protocolRoutes.set(host, handler);
}

function protocolHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function dispatchProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL}://`)) return;
  const route = protocolRoutes.get(protocolHost(url) ?? "");
  if (route) {
    void Promise.resolve()
      .then(() => route(url))
      .catch((e: unknown) => console.error("[cloud-auth] protocol route failed:", e))
      .finally(focusMainWindow);
    return;
  }
  if (isDeepLink(url)) {
    focusMainWindow();
    deliverDeepLink(url);
    return;
  }
  void handleOAuthCallback(url).finally(focusMainWindow);
}

// macOS: protocol URLs are delivered via open-url to the running instance.
app.on("open-url", (event, url) => {
  event.preventDefault();
  dispatchProtocolUrl(url);
});

// Windows/Linux: protocol URLs appear as argv on a second launch; we need
// a single-instance lock for them to reach the primary process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // CLI invocations (`infrawrench …` → app binary with --cli) probe the
    // lock to detect a running GUI; don't yank the window forward for them.
    if (argv.includes("--cli")) return;
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) dispatchProtocolUrl(url);
    else focusMainWindow();
  });
}
