/**
 * Sealed (encrypted, authenticated, expiring) values for the provider OAuth
 * round trip.
 *
 * - The `state` parameter carries everything the callback needs (org, user,
 *   plugin, where to return, the PKCE verifier) so no cookie or server-side
 *   session is required. That is what lets the desktop open the system
 *   browser, which has no web session, and still finish the flow.
 * - The `grant` handed back to the browser in place of the real grant state,
 *   so the refresh token never reaches it in plaintext. Saving an account
 *   unseals it again.
 *
 * Both are AES-256-GCM under the master key with a purpose-specific AAD, so
 * a state can never be replayed as a grant (or vice versa) and neither can
 * be read or forged without the key. Format: `<iv>.<ciphertext+tag>`, both
 * base64url, which survives a query string unescaped.
 */
import type { OAuthTokenSet } from "@infrawrench/plugin-base";

import { decrypt, encrypt } from "../encryption";

export const STATE_AAD = "provider-oauth:state";
export const GRANT_AAD = "provider-oauth:grant";

/** How long the user has to finish consenting at the provider. */
export const STATE_TTL_MS = 15 * 60 * 1000;
/** How long the user has to save the account form after connecting. */
export const GRANT_TTL_MS = 30 * 60 * 1000;

export type OAuthReturnTo = "web" | "desktop";

export interface ProviderOAuthState {
  orgId: string;
  userId: string;
  pluginId: string;
  returnTo: OAuthReturnTo;
  accountId?: string;
  codeVerifier?: string;
  nonce: string;
  /** Epoch milliseconds. */
  exp: number;
}

/** The token set without the provider's raw response (which may echo secrets we do not need). */
export type SealedTokenSet = Omit<OAuthTokenSet, "raw">;

export interface ProviderOAuthGrant {
  orgId: string;
  userId: string;
  pluginId: string;
  tokens: SealedTokenSet;
  client: "server";
  /** Epoch milliseconds. */
  exp: number;
}

const V2_PREFIX = "v2:";

function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64 + "=".repeat((4 - (base64.length % 4)) % 4);
}

/** Encrypt `payload` as JSON under `aad`. */
export async function sealValue(payload: object, aad: string): Promise<string> {
  const { ciphertext, iv } = await encrypt(JSON.stringify(payload), aad);
  if (!ciphertext.startsWith(V2_PREFIX)) throw new Error("Unexpected ciphertext format");
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext.slice(V2_PREFIX.length))}`;
}

/**
 * Decrypt a sealed value, or null when it is malformed, was sealed for a
 * different purpose, was tampered with, or is past its `exp`.
 */
export async function unsealValue<T extends { exp: number }>(
  sealed: string,
  aad: string,
  now: number = Date.now(),
): Promise<T | null> {
  if (typeof sealed !== "string" || sealed.length > 16_384) return null;
  const parts = sealed.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const plaintext = await decrypt(
      V2_PREFIX + fromBase64Url(parts[1]),
      fromBase64Url(parts[0]),
      aad,
    );
    const parsed = JSON.parse(plaintext) as T;
    if (!parsed || typeof parsed !== "object" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sealState(state: ProviderOAuthState): Promise<string> {
  return sealValue(state, STATE_AAD);
}

export function unsealState(sealed: string, now?: number): Promise<ProviderOAuthState | null> {
  return unsealValue<ProviderOAuthState>(sealed, STATE_AAD, now);
}

export function sealGrant(grant: ProviderOAuthGrant): Promise<string> {
  return sealValue(grant, GRANT_AAD);
}

export function unsealGrant(sealed: string, now?: number): Promise<ProviderOAuthGrant | null> {
  return unsealValue<ProviderOAuthGrant>(sealed, GRANT_AAD, now);
}

/** Drop the provider's raw response before sealing. */
export function sealableTokens(tokens: OAuthTokenSet): SealedTokenSet {
  const { raw: _raw, ...rest } = tokens;
  return rest;
}
