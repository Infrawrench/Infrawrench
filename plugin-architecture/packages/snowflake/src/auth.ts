/**
 * Authentication for the SQL API.
 *
 * Verified against "Authenticating to the server" for the SQL API
 * (docs.snowflake.com/en/developer-guide/sql-api/authenticating) and
 * "Using programmatic access tokens" (2026-10):
 *
 * - Key-pair: `Authorization: Bearer <JWT>` with
 *   `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT`. The JWT is RS256,
 *   `iss` = `<ACCOUNT>.<USER>.SHA256:<fingerprint>`, `sub` =
 *   `<ACCOUNT>.<USER>`, both upper-case, and is honoured for at most an hour
 *   whatever `exp` says. The fingerprint is the base64 SHA-256 of the
 *   DER-encoded SubjectPublicKeyInfo of the user's public key.
 * - Programmatic access token: `Authorization: Bearer <token>` with
 *   `X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN`.
 *
 * One credential field takes either: a PEM private key is recognised by its
 * armour, anything else is treated as a token. Everything runs on WebCrypto
 * so the same code signs in the desktop renderer, the server and the poller.
 */

export type SnowflakeCredential =
  { kind: "keypair"; pkcs8: Uint8Array } | { kind: "token"; token: string };

/** Classifies the secret the user pasted. Throws user-facing errors. */
export function parseCredential(raw: string): SnowflakeCredential {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error("Enter a private key (PEM) or a programmatic access token.");
  }
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(value)) {
    throw new Error(
      "This private key is encrypted. Paste the unencrypted key instead (openssl pkcs8 -topk8 -nocrypt -in rsa_key.p8 -out rsa_key_plain.p8), or use a programmatic access token.",
    );
  }
  const pkcs8 = value.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (pkcs8) return { kind: "keypair", pkcs8: base64ToBytes(pkcs8[1]!) };
  const pkcs1 = value.match(
    /-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/,
  );
  if (pkcs1) return { kind: "keypair", pkcs8: wrapPkcs1(base64ToBytes(pkcs1[1]!)) };
  if (/-----BEGIN/.test(value)) {
    throw new Error("Unrecognised key format. Paste an RSA private key in PEM (PKCS#8) form.");
  }
  if (/\s/.test(value)) {
    throw new Error("A programmatic access token is a single line with no spaces.");
  }
  return { kind: "token", token: value };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

const base64url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** DER length prefix. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * Wraps a PKCS#1 `RSAPrivateKey` in a PKCS#8 `PrivateKeyInfo`, the only RSA
 * private key format WebCrypto imports: SEQUENCE { INTEGER 0, SEQUENCE {
 * rsaEncryption OID, NULL }, OCTET STRING { pkcs1 } }.
 */
export function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLength = version.length + algorithm.length + octet.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(bodyLength), ...version, ...algorithm, ...octet]);
  const result = new Uint8Array(out.length + pkcs1.length);
  result.set(out, 0);
  result.set(pkcs1, out.length);
  return result;
}

interface KeyMaterial {
  signingKey: CryptoKey;
  fingerprint: string;
}

const keyCache = new Map<string, Promise<KeyMaterial>>();

async function loadKey(pkcs8: Uint8Array): Promise<KeyMaterial> {
  const cacheKey = bytesToBase64(pkcs8);
  let pending = keyCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
      let extractable: CryptoKey;
      try {
        extractable = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, algo, true, [
          "sign",
        ]);
      } catch {
        throw new Error("Snowflake: the private key could not be read. Paste an RSA private key.");
      }
      // WebCrypto cannot export a public key from a private one directly; the
      // JWK of the private key carries the modulus and exponent, which is the
      // public key.
      const jwk = await crypto.subtle.exportKey("jwk", extractable);
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true } as JsonWebKey,
        algo,
        true,
        ["verify"],
      );
      const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki as BufferSource));
      const signingKey = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8 as BufferSource,
        algo,
        false,
        ["sign"],
      );
      return { signingKey, fingerprint: `SHA256:${bytesToBase64(digest)}` };
    })();
    pending.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, pending);
  }
  return pending;
}

/** `SHA256:<base64>` fingerprint of the key's public half, as Snowflake shows it. */
export async function publicKeyFingerprint(pkcs8: Uint8Array): Promise<string> {
  return (await loadKey(pkcs8)).fingerprint;
}

/** Signs a key-pair JWT for `account` / `user`, valid for `lifetimeSec`. */
export async function signJwt(
  pkcs8: Uint8Array,
  jwtAccount: string,
  user: string,
  nowSec = Math.floor(Date.now() / 1000),
  lifetimeSec = 3540,
): Promise<string> {
  const { signingKey, fingerprint } = await loadKey(pkcs8);
  const qualified = `${jwtAccount.toUpperCase()}.${user.toUpperCase()}`;
  const header = base64url(btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    btoa(
      JSON.stringify({
        iss: `${qualified}.${fingerprint}`,
        sub: qualified,
        iat: nowSec,
        exp: nowSec + lifetimeSec,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signingKey,
      new TextEncoder().encode(unsigned) as BufferSource,
    ),
  );
  return `${unsigned}.${base64url(bytesToBase64(sig))}`;
}

/**
 * Builds the auth headers for one request, re-signing the JWT when the cached
 * one is within five minutes of Snowflake's one-hour ceiling.
 */
export class SnowflakeAuth {
  private jwt: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly credential: SnowflakeCredential,
    private readonly jwtAccount: string,
    private readonly user: string,
  ) {}

  get kind(): SnowflakeCredential["kind"] {
    return this.credential.kind;
  }

  async headers(): Promise<Record<string, string>> {
    if (this.credential.kind === "token") {
      return {
        Authorization: `Bearer ${this.credential.token}`,
        "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
      };
    }
    const now = Date.now();
    if (!this.jwt || this.jwt.expiresAt - now < 5 * 60_000) {
      if (!this.user) throw new Error("Snowflake: enter the user the key belongs to.");
      const nowSec = Math.floor(now / 1000);
      const token = await signJwt(this.credential.pkcs8, this.jwtAccount, this.user, nowSec);
      this.jwt = { token, expiresAt: (nowSec + 3540) * 1000 };
    }
    return {
      Authorization: `Bearer ${this.jwt.token}`,
      "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    };
  }
}
