// Cloud token store shared by the GUI (cloud-auth.ts) and the headless CLI
// (cli/). This module has NO import-time side effects — no protocol
// registration, no single-instance lock, no ipcMain handlers — so the CLI can
// use it without disturbing a running GUI instance. Tokens are encrypted with
// the local master key and persisted in the SQLite `cloud_sync_state` table,
// which is why a CLI invocation shares the desktop app's sign-in.
import crypto from "node:crypto";
import { getDb, getEncryptionKey, encryptValue, decryptValue } from "./main-utils";
import { CLIENT_ID, CLOUD_URL, WORKOS_API_URL } from "../env";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let currentTokens: TokenPair | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let proactiveRefreshTimer: NodeJS.Timeout | null = null;

// GUI wires this to a BrowserWindow broadcast; the CLI leaves it unset and
// surfaces errors through command output instead.
let authErrorNotifier: ((code: string, message: string) => void) | null = null;

// When the CLI runs alongside the GUI it must not write the SQLite file (the
// GUI's in-memory copy would clobber it on next persist) and must not refresh
// (WorkOS rotates refresh tokens, so a CLI refresh would invalidate the pair
// the GUI has stored). Read-only mode uses the stored access token as-is.
let readOnlyTokenStore = false;

export function setAuthErrorNotifier(fn: (code: string, message: string) => void): void {
  authErrorNotifier = fn;
}

export function setTokenStoreReadOnly(readOnly: boolean): void {
  readOnlyTokenStore = readOnly;
}

function notifyAuthError(code: string, message: string): void {
  authErrorNotifier?.(code, message);
}

// Refresh ~60s before access-token expiry, but never sooner than 30s from now
// (prevents tight-loop refreshes if exp is in the past or very near). The
// timer is unref'd so a finished CLI command isn't kept alive by it; the GUI
// process never exits on an empty event loop, so it still fires there.
function scheduleProactiveRefresh(expiresAt: number): void {
  if (readOnlyTokenStore) return;
  if (proactiveRefreshTimer) clearTimeout(proactiveRefreshTimer);
  const delay = Math.max(30_000, expiresAt - Date.now() - 60_000);
  proactiveRefreshTimer = setTimeout(() => {
    void refreshAccessToken();
  }, delay);
  proactiveRefreshTimer.unref?.();
}

function clearProactiveRefresh(): void {
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
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

async function storeTokenPair(tokens: TokenPair): Promise<void> {
  currentTokens = tokens;
  if (readOnlyTokenStore) return;

  const encKey = await getEncryptionKey();
  const { ciphertext: atCipher, iv: atIv } = encryptValue(tokens.accessToken, encKey);
  const { ciphertext: rtCipher, iv: rtIv } = encryptValue(tokens.refreshToken, encKey);
  await setSyncState("access_token_encrypted", atCipher);
  await setSyncState("access_token_iv", atIv);
  await setSyncState("refresh_token_encrypted", rtCipher);
  await setSyncState("refresh_token_iv", rtIv);
  await setSyncState("token_expires_at", String(tokens.expiresAt));
  scheduleProactiveRefresh(tokens.expiresAt);
}

export async function clearStoredTokens(): Promise<void> {
  currentTokens = null;
  clearProactiveRefresh();
  if (readOnlyTokenStore) return;
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

/**
 * Exchange a PKCE authorization code for tokens and persist them. Used by
 * both the GUI protocol callback and the CLI loopback callback.
 */
export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
): Promise<{ email: string; organizationId?: string | undefined }> {
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

  await storeTokenPair({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: jwtExpMillis(data.access_token),
  });
  await setSyncState("email", data.user.email);
  if (data.organization_id) {
    await setSyncState("organization_id", data.organization_id);
  }

  return { email: data.user.email, organizationId: data.organization_id };
}

// WorkOS rotates refresh tokens on each use, so concurrent refreshes race and
// all but one get invalid_grant. Singleflight gates them.
export async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  if (!currentTokens?.refreshToken) return false;
  // A rotated refresh token we can't persist would sign the desktop app out.
  if (readOnlyTokenStore) return false;

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
    // invalid_grant → refresh token is dead, sign the user out. Others are
    // treated as transient and the tokens are kept for a later retry.
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

  await storeTokenPair({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: jwtExpMillis(data.access_token),
  });
  return true;
}

// Called by cloudFetch on 401 to recover from server-side token rejection.
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

  if (currentTokens.expiresAt < Date.now() + 60_000) {
    if (readOnlyTokenStore) {
      // Can't refresh without persisting the rotated pair. The stored token
      // is still usable until its real expiry — the GUI proactively refreshes
      // ~60s early, so this window is rarely hit in practice.
      return currentTokens.expiresAt > Date.now() ? currentTokens.accessToken : null;
    }
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

/**
 * The signed-in user's organizations. `[]` means "signed out" (no token, or
 * the refresh token is dead) — a network or server failure throws instead, so
 * callers can tell "you have no organizations" from "the request failed". The
 * IPC handler serializes the rejection to the renderer, and the CLI's
 * top-level handler prints it.
 */
export async function fetchCloudOrgs(): Promise<
  Array<{ id: string; displayName: string; role: string }>
> {
  let token = await getAccessToken();
  if (!token) return [];

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
  if (!response.ok) {
    throw new Error(`Loading organizations failed: HTTP ${response.status}`);
  }
  return (await response.json()) as Array<{ id: string; displayName: string; role: string }>;
}

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export function createPkceChallenge(): PkceChallenge {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

export function buildAuthorizeUrl(challenge: PkceChallenge, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    provider: "authkit",
    code_challenge: challenge.codeChallenge,
    code_challenge_method: "S256",
    state: challenge.state,
  });
  return `${WORKOS_API_URL}/user_management/authorize?${params}`;
}
