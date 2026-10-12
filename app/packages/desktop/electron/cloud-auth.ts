// GUI-side cloud auth wiring: custom-protocol PKCE flow, single-instance
// lock, and the cloud_auth_* IPC handlers. All token storage/refresh logic
// lives in cloud-tokens.ts, which is side-effect free and shared with the CLI.
import { app, shell, ipcMain, BrowserWindow } from "electron";
import crypto from "node:crypto";
import {
  setAuthErrorNotifier,
  exchangeAuthorizationCode,
  getAccessToken,
  forceRefreshAccessToken,
  getAuthStatus,
  fetchCloudOrgs,
  createPkceChallenge,
  buildAuthorizeUrl,
} from "./cloud-tokens";
import { PROTOCOL, CLOUD_URL } from "../env";
import { deliverDeepLink, isDeepLink } from "./deep-links";

export { getAccessToken, forceRefreshAccessToken };

setAuthErrorNotifier((code, message) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("cloud_auth_error", { code, message });
  }
});

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

let codeVerifier: string | null = null;
let oauthState: string | null = null;

function startOAuthFlow(): void {
  const challenge = createPkceChallenge();
  codeVerifier = challenge.codeVerifier;
  // Without `state`, any infrawrench:// URL with a valid code would be
  // accepted: CSRF against the custom protocol handler.
  oauthState = challenge.state;
  void shell.openExternal(buildAuthorizeUrl(challenge, `${PROTOCOL}://callback`));
}

function notifyAuthError(code: string, message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("cloud_auth_error", { code, message });
  }
}

async function handleOAuthCallback(callbackUrl: string): Promise<void> {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !codeVerifier || !oauthState) {
    console.error("[cloud-auth] Missing code, verifier, or state");
    notifyAuthError("missing-code", "Sign-in callback missing code or verifier");
    return;
  }
  if (
    !returnedState ||
    returnedState.length !== oauthState.length ||
    !crypto.timingSafeEqual(Buffer.from(returnedState), Buffer.from(oauthState))
  ) {
    console.error("[cloud-auth] OAuth state mismatch, refusing callback");
    notifyAuthError("state-mismatch", "Sign-in callback rejected (state mismatch)");
    codeVerifier = null;
    oauthState = null;
    return;
  }

  try {
    await exchangeAuthorizationCode(code, codeVerifier);
  } catch (e) {
    console.error("[cloud-auth] Token exchange error:", e);
    notifyAuthError("token-exchange", e instanceof Error ? e.message : String(e));
  } finally {
    codeVerifier = null;
    oauthState = null;
  }
}

ipcMain.handle("cloud_auth_start", () => {
  startOAuthFlow();
  return { ok: true };
});

ipcMain.handle("cloud_auth_status", () => getAuthStatus());
ipcMain.handle("cloud_auth_orgs", () => fetchCloudOrgs());
ipcMain.handle("cloud_get_url", () => CLOUD_URL);

// Short-lived single-use token for `?token=` on the WS upgrade URL.
ipcMain.handle(
  "cloud_auth_get_ws_token",
  async (_e, { orgId }: { orgId: string }): Promise<string | null> => {
    let accessToken = await getAccessToken();
    if (!accessToken) return null;
    const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/ws-token`;
    const headers = (t: string) => ({
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    });
    let res = await fetch(url, { method: "POST", headers: headers(accessToken) });
    if (res.status === 401) {
      const refreshed = await forceRefreshAccessToken();
      if (!refreshed) return null;
      accessToken = refreshed;
      res = await fetch(url, { method: "POST", headers: headers(accessToken) });
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  },
);
