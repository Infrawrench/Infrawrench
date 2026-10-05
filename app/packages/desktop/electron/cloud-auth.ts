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

function dispatchProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL}://`)) return;
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

function startOAuthFlow(workosOrganizationId?: string): void {
  const challenge = createPkceChallenge();
  codeVerifier = challenge.codeVerifier;
  // Without `state`, any infrawrench:// URL with a valid code would be
  // accepted: CSRF against the custom protocol handler.
  oauthState = challenge.state;
  void shell.openExternal(
    buildAuthorizeUrl(challenge, `${PROTOCOL}://callback`, workosOrganizationId),
  );
}

/** WorkOS organization ids are `org_` plus a ULID; anything else is refused. */
const WORKOS_ORG_ID = /^org_[0-9A-Za-z]{10,64}$/;
const SSO_SIGN_IN_COOLDOWN_MS = 2 * 60 * 1000;
let lastSsoSignInAt = 0;

/**
 * An org answered `sso_required`: this session was not established through
 * its identity provider. Open sign-in at that provider, at most once every
 * two minutes, since every open screen will be hitting the same 403. Takes the
 * raw response body so callers need not parse it first; anything that is not
 * the structured payload is ignored.
 */
export function maybeStartSsoSignIn(bodyText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  // Checked by hand: client-core is ESM and this module is CommonJS, and the
  // shape is two fields.
  const body = parsed as { code?: unknown; workosOrganizationId?: unknown } | null;
  if (
    !body ||
    body.code !== "sso_required" ||
    typeof body.workosOrganizationId !== "string" ||
    !WORKOS_ORG_ID.test(body.workosOrganizationId)
  ) {
    return false;
  }
  if (Date.now() - lastSsoSignInAt < SSO_SIGN_IN_COOLDOWN_MS) return true;
  lastSsoSignInAt = Date.now();
  startOAuthFlow(body.workosOrganizationId);
  return true;
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
    console.error("[cloud-auth] OAuth state mismatch — refusing callback");
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

ipcMain.handle("cloud_auth_start", (_e, args?: { workosOrganizationId?: unknown }) => {
  const orgId = args?.workosOrganizationId;
  startOAuthFlow(typeof orgId === "string" && WORKOS_ORG_ID.test(orgId) ? orgId : undefined);
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
