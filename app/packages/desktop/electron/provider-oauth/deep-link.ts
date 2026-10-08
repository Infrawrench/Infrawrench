/**
 * The cloud-mode result of a provider OAuth flow: the server's callback
 * redirects the browser to `infrawrench://provider-oauth?payload=<base64url
 * JSON>` and the OS hands that URL to the app. Pure parsing and the
 * one-pending-flow bookkeeping live here; routing the URL is cloud-auth.ts.
 */
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";

export const PROVIDER_OAUTH_DEEP_LINK_HOST = "provider-oauth";
export const PROVIDER_OAUTH_PAYLOAD_TYPE = "infrawrench:provider-oauth";

export type ProviderOAuthPayload =
  | {
      type: typeof PROVIDER_OAUTH_PAYLOAD_TYPE;
      ok: true;
      pluginId: string;
      accountId?: string;
      credentials: Record<string, string>;
      accountName?: string;
    }
  | { type: typeof PROVIDER_OAUTH_PAYLOAD_TYPE; ok: false; pluginId: string; error: string };

function decodeBase64Url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8");
}

/** Parse and validate a deep link. Returns null for anything that is not a well-formed result. */
export function parseProviderOAuthDeepLink(rawUrl: string): ProviderOAuthPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname !== PROVIDER_OAUTH_DEEP_LINK_HOST) return null;
  const encoded = url.searchParams.get("payload");
  if (!encoded || encoded.length > 64 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(encoded));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p["type"] !== PROVIDER_OAUTH_PAYLOAD_TYPE || typeof p["pluginId"] !== "string") return null;
  if (p["ok"] === false) {
    return {
      type: PROVIDER_OAUTH_PAYLOAD_TYPE,
      ok: false,
      pluginId: p["pluginId"],
      error: typeof p["error"] === "string" ? p["error"] : "The connection failed.",
    };
  }
  if (p["ok"] !== true) return null;
  const rawCredentials = p["credentials"];
  if (!rawCredentials || typeof rawCredentials !== "object") return null;
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawCredentials as Record<string, unknown>)) {
    if (typeof value === "string") credentials[key] = value;
  }
  // The sealed grant is what makes the result unforgeable: the server only
  // accepts one it sealed for this org, user and plugin. A link without one
  // could carry anybody's pasted token, so it is not a result.
  if (!credentials[OAUTH_CREDENTIAL_KEY]) return null;
  return {
    type: PROVIDER_OAUTH_PAYLOAD_TYPE,
    ok: true,
    pluginId: p["pluginId"],
    ...(typeof p["accountId"] === "string" ? { accountId: p["accountId"] } : {}),
    credentials,
    ...(typeof p["accountName"] === "string" && p["accountName"]
      ? { accountName: p["accountName"] }
      : {}),
  };
}

export interface PendingCloudFlow {
  pluginId: string;
  accountId?: string;
  resolve: (payload: ProviderOAuthPayload) => void;
}

/**
 * Deliver a parsed payload to the pending flow when it is the one waiting.
 * Returns whether it was consumed; a result nobody is waiting for (stale, or
 * from a link someone else made) is ignored.
 */
export function deliverToPendingFlow(
  pending: PendingCloudFlow | null,
  payload: ProviderOAuthPayload,
): boolean {
  if (!pending || pending.pluginId !== payload.pluginId) return false;
  if (
    payload.ok &&
    pending.accountId !== undefined &&
    payload.accountId !== undefined &&
    payload.accountId !== pending.accountId
  ) {
    return false;
  }
  pending.resolve(payload);
  return true;
}
