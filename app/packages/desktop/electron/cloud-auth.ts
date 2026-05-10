import { app, shell, ipcMain, BrowserWindow } from "electron";
import crypto from "node:crypto";
import { getDb, getEncryptionKey, encryptValue, decryptValue } from "./main-utils";
import { PROTOCOL, CLIENT_ID, CLOUD_URL, WORKOS_API_URL } from "../env";

function notifyAuthError(code: string, message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("cloud_auth_error", { code, message });
  }
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let currentTokens: TokenPair | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let proactiveRefreshTimer: NodeJS.Timeout | null = null;

// Refresh ~60s before access-token expiry, but never sooner than 30s from now
// (prevents tight-loop refreshes if exp is in the past or very near).
function scheduleProactiveRefresh(expiresAt: number): void {
  if (proactiveRefreshTimer) clearTimeout(proactiveRefreshTimer);
  const delay = Math.max(30_000, expiresAt - Date.now() - 60_000);
  proactiveRefreshTimer = setTimeout(() => {
    void refreshAccessToken();
  }, delay);
}

function clearProactiveRefresh(): void {
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
}

// Register custom protocol handler
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

// Windows/Linux: protocol URLs appear as argv on a second launch — we need
// a single-instance lock for them to reach the primary process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) dispatchProtocolUrl(url);
    else focusMainWindow();
  });
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

async function getSyncState(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM cloud_sync_state WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

async function setSyncState(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT OR REPLACE INTO cloud_sync_state (key, value) VALUES ($1, $2)", [
    key,
    value,
  ]);
}

async function deleteSyncState(key: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM cloud_sync_state WHERE key = $1", [key]);
}

let codeVerifier: string | null = null;

function startOAuthFlow(): void {
  codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: `${PROTOCOL}://callback`,
    provider: "authkit",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const url = `${WORKOS_API_URL}/user_management/authorize?${params}`;
  void shell.openExternal(url);
}

function jwtExpMillis(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return Date.now() + 5 * 60 * 1000;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + 5 * 60 * 1000;
  } catch {
    return Date.now() + 5 * 60 * 1000;
  }
}

async function handleOAuthCallback(callbackUrl: string): Promise<void> {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  if (!code || !codeVerifier) {
    console.error("[cloud-auth] Missing code or code verifier");
    notifyAuthError("missing-code", "Sign-in callback missing code or verifier");
    return;
  }

  try {
    const response = await fetch(`${WORKOS_API_URL}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      user: { email: string };
      organization_id?: string;
    };

    const tokens: TokenPair = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: jwtExpMillis(data.access_token),
    };

    currentTokens = tokens;

    const encKey = await getEncryptionKey();
    const { ciphertext: atCipher, iv: atIv } = encryptValue(tokens.accessToken, encKey);
    const { ciphertext: rtCipher, iv: rtIv } = encryptValue(tokens.refreshToken, encKey);

    await setSyncState("access_token_encrypted", atCipher);
    await setSyncState("access_token_iv", atIv);
    await setSyncState("refresh_token_encrypted", rtCipher);
    await setSyncState("refresh_token_iv", rtIv);
    await setSyncState("token_expires_at", String(tokens.expiresAt));
    await setSyncState("email", data.user.email);
    if (data.organization_id) {
      await setSyncState("organization_id", data.organization_id);
    }

    scheduleProactiveRefresh(tokens.expiresAt);
  } catch (e) {
    console.error("[cloud-auth] Token exchange error:", e);
    notifyAuthError("token-exchange", e instanceof Error ? e.message : String(e));
  } finally {
    codeVerifier = null;
  }
}

async function clearStoredTokens(): Promise<void> {
  for (const key of [
    "access_token_encrypted",
    "access_token_iv",
    "refresh_token_encrypted",
    "refresh_token_iv",
    "token_expires_at",
  ]) {
    await deleteSyncState(key);
  }
}

// Singleflight: concurrent callers share one in-flight refresh. Without this,
// multiple callers race to spend the same refresh token and all but one get
// invalid_grant from WorkOS (which rotates refresh tokens on every use).
async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  if (!currentTokens?.refreshToken) return false;

  let response: Response;
  try {
    response = await fetch(`${WORKOS_API_URL}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: currentTokens.refreshToken,
      }),
    });
  } catch (e) {
    // Network error — keep tokens so a later attempt can succeed.
    console.warn("[cloud-auth] Refresh network error, will retry:", e);
    return false;
  }

  if (!response.ok) {
    // 4xx with invalid_grant → refresh token is dead, sign the user out fully.
    // Other statuses (5xx, transient) → keep tokens for a later attempt.
    const text = await response.text().catch(() => "");
    let isHardFailure = false;
    if (response.status >= 400 && response.status < 500) {
      try {
        const body = JSON.parse(text) as { error?: string };
        isHardFailure = body.error === "invalid_grant";
      } catch {
        isHardFailure = response.status === 400 || response.status === 401;
      }
    }
    if (isHardFailure) {
      console.warn("[cloud-auth] Refresh rejected by server, signing out:", text);
      currentTokens = null;
      clearProactiveRefresh();
      await clearStoredTokens();
      notifyAuthError("refresh-revoked", "Sign-in expired, please sign in again");
    } else {
      console.warn("[cloud-auth] Refresh failed (transient), will retry:", response.status, text);
    }
    return false;
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };

  currentTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: jwtExpMillis(data.access_token),
  };

  const encKey = await getEncryptionKey();
  const { ciphertext: atCipher, iv: atIv } = encryptValue(currentTokens.accessToken, encKey);
  const { ciphertext: rtCipher, iv: rtIv } = encryptValue(currentTokens.refreshToken, encKey);
  await setSyncState("access_token_encrypted", atCipher);
  await setSyncState("access_token_iv", atIv);
  await setSyncState("refresh_token_encrypted", rtCipher);
  await setSyncState("refresh_token_iv", rtIv);
  await setSyncState("token_expires_at", String(currentTokens.expiresAt));

  scheduleProactiveRefresh(currentTokens.expiresAt);
  return true;
}

// Force a refresh even if the current access token isn't yet expired. Used by
// cloudFetch on 401 to recover from server-side token rejection.
export async function forceRefreshAccessToken(): Promise<string | null> {
  const ok = await refreshAccessToken();
  return ok && currentTokens ? currentTokens.accessToken : null;
}

export async function getAccessToken(): Promise<string | null> {
  if (!currentTokens) {
    const encKey = await getEncryptionKey();
    const atCipher = await getSyncState("access_token_encrypted");
    const atIv = await getSyncState("access_token_iv");
    const rtCipher = await getSyncState("refresh_token_encrypted");
    const rtIv = await getSyncState("refresh_token_iv");
    const expiresAt = await getSyncState("token_expires_at");

    if (!atCipher || !atIv || !rtCipher || !rtIv) return null;

    currentTokens = {
      accessToken: decryptValue(atCipher, atIv, encKey),
      refreshToken: decryptValue(rtCipher, rtIv, encKey),
      expiresAt: Number(expiresAt ?? 0),
    };
    scheduleProactiveRefresh(currentTokens.expiresAt);
  }

  // Refresh if within 60s of expiry. On transient failure, keep currentTokens
  // so the next caller can retry; only invalid_grant clears them (handled above).
  if (currentTokens.expiresAt < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) return null;
  }

  return currentTokens?.accessToken ?? null;
}

export async function getAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string | undefined;
  organizationId?: string | undefined;
}> {
  const token = await getAccessToken();
  if (!token) return { authenticated: false };

  const email = await getSyncState("email");
  const orgId = await getSyncState("organization_id");

  return {
    authenticated: true,
    email: email ?? undefined,
    organizationId: orgId ?? undefined,
  };
}

async function logout(): Promise<void> {
  currentTokens = null;
  clearProactiveRefresh();
  for (const key of [
    "access_token_encrypted",
    "access_token_iv",
    "refresh_token_encrypted",
    "refresh_token_iv",
    "token_expires_at",
    "email",
    "organization_id",
    "last_sync_version",
    "last_push_at",
  ]) {
    await deleteSyncState(key);
  }
}

async function fetchCloudOrgs(): Promise<Array<{ id: string; displayName: string; role: string }>> {
  let token = await getAccessToken();
  if (!token) return [];

  try {
    let response = await fetch(`${CLOUD_URL}/api/auth/orgs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      const refreshed = await forceRefreshAccessToken();
      if (!refreshed) return [];
      token = refreshed;
      response = await fetch(`${CLOUD_URL}/api/auth/orgs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (!response.ok) return [];
    return (await response.json()) as Array<{ id: string; displayName: string; role: string }>;
  } catch {
    return [];
  }
}

ipcMain.handle("cloud_auth_start", () => {
  startOAuthFlow();
  return { ok: true };
});

ipcMain.handle("cloud_auth_status", () => getAuthStatus());
ipcMain.handle("cloud_auth_logout", () => logout());
ipcMain.handle("cloud_auth_get_token", () => getAccessToken());
ipcMain.handle("cloud_auth_orgs", () => fetchCloudOrgs());
ipcMain.handle("cloud_get_url", () => CLOUD_URL);

/**
 * Mint a short-lived WebSocket session token scoped to an org.
 * The server at /api/org/:orgId/ws-token exchanges a WorkOS JWT for a
 * single-use token suitable for `?token=` on the WS upgrade URL.
 */
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
