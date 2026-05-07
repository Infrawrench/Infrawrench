import { z } from "zod";

export const serviceAccountKeySchema = z.object({
  type: z.string(),
  project_id: z.string(),
  private_key_id: z.string(),
  private_key: z.string(),
  client_email: z.string(),
  client_id: z.string(),
  auth_uri: z.string(),
  token_uri: z.string(),
});

export type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;

const accessTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
});

const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function base64url(data: string): string {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function makeJwt(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: GCP_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${payload}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${unsigned}.${sigB64}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Process-wide token cache + in-flight dedup, keyed by service account.
// Persisting across GcpClient instances avoids hammering the OAuth endpoint
// on every request, since a fresh client is constructed per API call.
const tokenCache = new Map<string, CachedToken>();
const tokenInFlight = new Map<string, Promise<string>>();

function cacheKey(key: ServiceAccountKey): string {
  return `${key.client_email}:${key.private_key_id}`;
}

async function fetchAccessTokenRaw(
  key: ServiceAccountKey,
): Promise<{ token: string; expiresInSec: number }> {
  const jwt = await makeJwt(key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`GCP auth error ${res.status}: ${await res.text()}`);
  }
  const data = accessTokenResponseSchema.parse(await res.json());
  return { token: data.access_token, expiresInSec: data.expires_in ?? 3600 };
}

export async function fetchAccessToken(key: ServiceAccountKey): Promise<string> {
  const k = cacheKey(key);
  const now = Date.now();
  const cached = tokenCache.get(k);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const pending = tokenInFlight.get(k);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const { token, expiresInSec } = await fetchAccessTokenRaw(key);
      tokenCache.set(k, { token, expiresAt: Date.now() + expiresInSec * 1000 });
      return token;
    } finally {
      tokenInFlight.delete(k);
    }
  })();
  tokenInFlight.set(k, promise);
  return promise;
}

export function invalidateAccessToken(key: ServiceAccountKey): void {
  tokenCache.delete(cacheKey(key));
}
