import { app, shell, ipcMain } from "electron";
import crypto from "node:crypto";
import { getDb, getEncryptionKey, encryptValue, decryptValue } from "./main-utils";

const PROTOCOL = "infrawrench";
const CLIENT_ID = process.env["WORKOS_CLIENT_ID"] ?? "";
const CLOUD_URL = process.env["INFRAWRENCH_CLOUD_URL"] ?? "http://localhost:3000";
const WORKOS_API_URL = "https://api.workos.com";

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let currentTokens: TokenPair | null = null;

// Register custom protocol handler
app.setAsDefaultProtocolClient(PROTOCOL);

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
  await db.execute(
    "INSERT OR REPLACE INTO cloud_sync_state (key, value) VALUES ($1, $2)",
    [key, value],
  );
}

async function deleteSyncState(key: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM cloud_sync_state WHERE key = $1", [key]);
}

// PKCE helpers
let codeVerifier: string | null = null;

export function startOAuthFlow(): void {
  // Generate PKCE code verifier and challenge
  codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: `${PROTOCOL}://callback`,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const url = `${WORKOS_API_URL}/sso/authorize?${params}`;
  void shell.openExternal(url);
}

export async function handleOAuthCallback(callbackUrl: string): Promise<void> {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  if (!code || !codeVerifier) {
    console.error("[cloud-auth] Missing code or code verifier");
    return;
  }

  try {
    const response = await fetch(`${WORKOS_API_URL}/sso/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: `${PROTOCOL}://callback`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      profile: { email: string; organization_id?: string };
    };

    const tokens: TokenPair = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    currentTokens = tokens;

    // Encrypt and store tokens
    const encKey = await getEncryptionKey();
    const { ciphertext: atCipher, iv: atIv } = encryptValue(tokens.accessToken, encKey);
    const { ciphertext: rtCipher, iv: rtIv } = encryptValue(tokens.refreshToken, encKey);

    await setSyncState("access_token_encrypted", atCipher);
    await setSyncState("access_token_iv", atIv);
    await setSyncState("refresh_token_encrypted", rtCipher);
    await setSyncState("refresh_token_iv", rtIv);
    await setSyncState("token_expires_at", String(tokens.expiresAt));
    await setSyncState("email", data.profile.email);
    if (data.profile.organization_id) {
      await setSyncState("organization_id", data.profile.organization_id);
    }
  } catch (e) {
    console.error("[cloud-auth] Token exchange error:", e);
  } finally {
    codeVerifier = null;
  }
}

async function refreshAccessToken(): Promise<boolean> {
  if (!currentTokens?.refreshToken) return false;

  try {
    const response = await fetch(`${WORKOS_API_URL}/sso/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: currentTokens.refreshToken,
      }),
    });

    if (!response.ok) return false;

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    currentTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    // Persist updated tokens
    const encKey = await getEncryptionKey();
    const { ciphertext: atCipher, iv: atIv } = encryptValue(currentTokens.accessToken, encKey);
    const { ciphertext: rtCipher, iv: rtIv } = encryptValue(currentTokens.refreshToken, encKey);
    await setSyncState("access_token_encrypted", atCipher);
    await setSyncState("access_token_iv", atIv);
    await setSyncState("refresh_token_encrypted", rtCipher);
    await setSyncState("refresh_token_iv", rtIv);
    await setSyncState("token_expires_at", String(currentTokens.expiresAt));

    return true;
  } catch {
    return false;
  }
}

export async function getAccessToken(): Promise<string | null> {
  if (!currentTokens) {
    // Try to load from DB
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
  }

  // Refresh if expired
  if (currentTokens.expiresAt < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      currentTokens = null;
      return null;
    }
  }

  return currentTokens.accessToken;
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

export async function logout(): Promise<void> {
  currentTokens = null;
  for (const key of [
    "access_token_encrypted", "access_token_iv",
    "refresh_token_encrypted", "refresh_token_iv",
    "token_expires_at", "email", "organization_id",
    "last_sync_version", "last_push_at",
  ]) {
    await deleteSyncState(key);
  }
}

export async function fetchCloudOrgs(): Promise<
  Array<{ id: string; displayName: string; role: string }>
> {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const response = await fetch(`${CLOUD_URL}/api/auth/orgs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    return (await response.json()) as Array<{ id: string; displayName: string; role: string }>;
  } catch {
    return [];
  }
}

// Register IPC handlers
ipcMain.handle("cloud_auth_start", () => {
  startOAuthFlow();
  return { ok: true };
});

ipcMain.handle("cloud_auth_status", () => getAuthStatus());
ipcMain.handle("cloud_auth_logout", () => logout());
ipcMain.handle("cloud_auth_get_token", () => getAccessToken());
ipcMain.handle("cloud_auth_orgs", () => fetchCloudOrgs());
