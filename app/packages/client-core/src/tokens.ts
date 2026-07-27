/**
 * Platform-neutral WorkOS token manager, ported from the desktop app's
 * `electron/cloud-tokens.ts`. Storage, fetch, and configuration are injected
 * so the same logic runs on mobile (Expo SecureStore + expo/fetch), and can
 * later back the desktop/web clients too.
 *
 * PKCE challenge generation is intentionally NOT here — platform auth
 * libraries (e.g. expo-auth-session) generate the verifier/challenge pair
 * themselves; this module takes over at the code-exchange step.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Unix millis parsed from the access token's `exp` claim. */
  expiresAt: number;
}

/** Minimal async key-value store; keys hold sensitive strings. */
export interface TokenStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TokenManagerOptions {
  storage: TokenStorage;
  /** WorkOS User Management client id (e.g. `client_...`). */
  clientId: string;
  /** WorkOS API origin, e.g. `https://api.workos.com`. */
  workosApiUrl: string;
  /** Bound fetch implementation; pass `expo/fetch`'s fetch on mobile. */
  fetch?: typeof fetch;
  /** Called on hard auth failures (revoked refresh token) — route to sign-in. */
  onAuthError?: (code: string, message: string) => void;
  /**
   * Abort a WorkOS token request after this long. Defaults to 15s.
   *
   * These calls sit on the app's launch path — a host that accepts the
   * connection and then never answers (captive portal, dead VPN, a server
   * that is up but wedged) would otherwise leave the promise pending
   * forever, and a launch screen waiting on it spins with no error and no
   * way out.
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const STORAGE_KEYS = {
  accessToken: "cloud_access_token",
  refreshToken: "cloud_refresh_token",
  expiresAt: "cloud_token_expires_at",
  email: "cloud_email",
} as const;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode a base64url string to UTF-8 without Buffer or atob — pure JS so it
 * runs identically on Node, browsers, and React Native (Hermes).
 */
function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const ch of base64) {
    const value = B64_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error("invalid base64");
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >> bitCount) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function jwtExpMillis(jwt: string, now = Date.now()): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return now + 5 * 60 * 1000;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]!)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : now + 5 * 60 * 1000;
  } catch {
    return now + 5 * 60 * 1000;
  }
}

export class TokenManager {
  private current: TokenPair | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private readonly storage: TokenStorage;
  private readonly clientId: string;
  private readonly workosApiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onAuthError: ((code: string, message: string) => void) | undefined;
  private readonly requestTimeoutMs: number;

  constructor(opts: TokenManagerOptions) {
    this.storage = opts.storage;
    this.clientId = opts.clientId;
    this.workosApiUrl = opts.workosApiUrl;
    this.fetchImpl = opts.fetch ?? fetch;
    this.onAuthError = opts.onAuthError;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * `fetch` that gives up rather than hanging. Uses an AbortController rather
   * than `AbortSignal.timeout` so it behaves the same on Hermes.
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Exchange a PKCE authorization code for tokens and persist them. The
   * verifier comes from the platform's auth-session library.
   */
  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ email: string; organizationId?: string | undefined }> {
    const response = await this.fetchWithTimeout(
      `${this.workosApiUrl}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: this.clientId,
          code,
          code_verifier: codeVerifier,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      user: { email: string };
      organization_id?: string;
    };
    await this.store({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: jwtExpMillis(data.access_token),
    });
    await this.storage.set(STORAGE_KEYS.email, data.user.email);
    return { email: data.user.email, organizationId: data.organization_id };
  }

  /**
   * Refresh the token pair. WorkOS rotates refresh tokens on each use, so
   * concurrent refreshes race and all but one get `invalid_grant` —
   * single-flight gates them.
   */
  refreshAccessToken(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<boolean> {
    const tokens = await this.load();
    if (!tokens?.refreshToken) return false;

    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.workosApiUrl}/user_management/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: this.clientId,
          refresh_token: tokens.refreshToken,
        }),
      });
    } catch {
      // Network error, or we gave up waiting — keep tokens so a later attempt
      // can succeed.
      return false;
    }

    if (!response.ok) {
      // invalid_grant → refresh token is dead, sign the user out. Others are
      // transient; keep the tokens for a later retry.
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
        await this.clear();
        this.onAuthError?.("refresh-revoked", "Sign-in expired, please sign in again");
      }
      return false;
    }

    const data = (await response.json()) as { access_token: string; refresh_token: string };
    await this.store({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: jwtExpMillis(data.access_token),
    });
    return true;
  }

  /** Called by the fetch wrapper on 401 to recover from server-side rejection. */
  async forceRefreshAccessToken(): Promise<string | null> {
    const ok = await this.refreshAccessToken();
    return ok && this.current ? this.current.accessToken : null;
  }

  /**
   * Current access token, proactively refreshed when within 60s of expiry.
   * Returns null when signed out (or the refresh token is dead).
   */
  async getAccessToken(): Promise<string | null> {
    const tokens = await this.load();
    if (!tokens) return null;
    if (tokens.expiresAt < Date.now() + 60_000) {
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) return null;
    }
    return this.current?.accessToken ?? null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAccessToken()) !== null;
  }

  async getStoredEmail(): Promise<string | null> {
    return this.storage.get(STORAGE_KEYS.email);
  }

  /** Drop all persisted tokens (sign-out). */
  async clear(): Promise<void> {
    this.current = null;
    for (const key of Object.values(STORAGE_KEYS)) {
      await this.storage.delete(key);
    }
  }

  private async store(tokens: TokenPair): Promise<void> {
    this.current = tokens;
    await this.storage.set(STORAGE_KEYS.accessToken, tokens.accessToken);
    await this.storage.set(STORAGE_KEYS.refreshToken, tokens.refreshToken);
    await this.storage.set(STORAGE_KEYS.expiresAt, String(tokens.expiresAt));
  }

  private async load(): Promise<TokenPair | null> {
    if (this.current) return this.current;
    const [accessToken, refreshToken, expiresAt] = await Promise.all([
      this.storage.get(STORAGE_KEYS.accessToken),
      this.storage.get(STORAGE_KEYS.refreshToken),
      this.storage.get(STORAGE_KEYS.expiresAt),
    ]);
    if (!accessToken || !refreshToken) return null;
    this.current = { accessToken, refreshToken, expiresAt: Number(expiresAt ?? 0) };
    return this.current;
  }
}
