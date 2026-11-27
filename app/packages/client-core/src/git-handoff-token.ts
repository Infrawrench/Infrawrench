/**
 * The signed tokens that send a browser from git.infrawrench.com to the app
 * to pay for something: a short username (`git-username-checkout-token.ts`)
 * or a workspace (`git-workspace-checkout-token.ts`). This is the format they
 * share; each kind has its own prefix, label and claims.
 *
 * `<prefix><payload>.<signature>`: base64url of compact JSON, and base64url
 * of HMAC-SHA256 over the kind's label and the payload's text under
 * `GIT_JOB_TOKEN_KEY`, the one signing key both deployments already have.
 * The label is in what is signed, so a token of one kind never verifies as
 * another, nor as a job token, whatever prefix is put on it.
 */

export type GitHandoffTokenRefusal = "malformed" | "signature" | "expired";

export interface GitHandoffTokenKind {
  readonly prefix: string;
  /** Signed with the payload, never sent. Ends with a newline. */
  readonly label: string;
  readonly maxLength: number;
}

const MIN_KEY_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(`The git job token key must be at least ${MIN_KEY_LENGTH} characters.`);
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Signs `body` as a token of `kind`. Throws on a key too short to sign with. */
export async function signGitHandoffToken(
  secret: string,
  kind: GitHandoffTokenKind,
  body: Readonly<Record<string, unknown>>,
): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(body)));
  const key = await hmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(kind.label + payload));
  return `${kind.prefix}${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Checks a token of `kind`: its signature (in constant time, by WebCrypto),
 * then its claims with `read` (null for a body that is not this kind's), then
 * its expiry. The claims of a refused token are never returned.
 */
export async function verifyGitHandoffToken<Claims extends { readonly expiresAt: number }>(
  secret: string,
  kind: GitHandoffTokenKind,
  token: string,
  read: (body: Readonly<Record<string, unknown>>) => Claims | null,
  now: number = Date.now(),
): Promise<{ ok: true; claims: Claims } | { ok: false; reason: GitHandoffTokenRefusal }> {
  const refused = (reason: GitHandoffTokenRefusal) => ({ ok: false as const, reason });
  if (
    typeof token !== "string" ||
    token.length > kind.maxLength ||
    !token.startsWith(kind.prefix)
  ) {
    return refused("malformed");
  }
  const body = token.slice(kind.prefix.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot !== body.lastIndexOf(".")) return refused("malformed");
  const payload = body.slice(0, dot);
  const signature = fromBase64Url(body.slice(dot + 1));
  const payloadBytes = fromBase64Url(payload);
  if (!signature || !payloadBytes || signature.length !== 32) return refused("malformed");

  const key = await hmacKey(secret, "verify");
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(kind.label + payload),
  );
  if (!valid) return refused("signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return refused("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refused("malformed");
  }
  const claims = read(parsed as Record<string, unknown>);
  if (claims === null || !Number.isSafeInteger(claims.expiresAt)) return refused("malformed");
  if (claims.expiresAt <= Math.floor(now / 1000)) return refused("expired");
  return { ok: true, claims };
}
