/**
 * Client-side helpers for the SSH host-key trust handshake.
 *
 * Routes that touch SSH/SFTP/tunnels can return HTTP 409 with
 * `{ error: "ssh_host_key_trust_required", ... }` when the host key has
 * either never been seen or has changed since it was last pinned. The
 * frontend is expected to show the presented fingerprint to the operator,
 * POST to /trust if the operator accepts, and then retry the original
 * action.
 */

// The payload shape, its guard, and the request-body builder are shared with
// mobile through client-core; only the `fetch`-shaped helpers below are
// web-specific. Re-exported so existing web imports keep working.
import {
  hostKeyTrustRequestBody,
  isHostKeyTrustResponse,
  type HostKeyTrustPayload,
} from "@infrawrench/ui";

export {
  isHostKeyTrustResponse,
  trustPayloadFromFrame,
  hostKeyLabel,
  type HostKeyTrustPayload,
} from "@infrawrench/ui";

/**
 * Try to parse a `fetch` Response as a host-key-trust 409. Returns the
 * payload if matched, otherwise null. Consumes the response body — only
 * call this after `res.ok` is false. The response is cloned before reading,
 * so the caller can still inspect the original body for non-matches if
 * needed.
 */
export async function tryParseHostKeyTrustResponse(
  res: Response,
): Promise<HostKeyTrustPayload | null> {
  if (res.status !== 409) return null;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return null;
  }
  return isHostKeyTrustResponse(body) ? body : null;
}

/**
 * POST /api/org/:orgId/ssh-host-keys/trust with the presented fingerprint.
 * Resolves on success; rejects with an Error whose `cause` is the parsed
 * 409 payload if a concurrent race caused the presented fingerprint to
 * change again. Other failures throw a plain Error.
 */
export async function trustHostKey(orgId: string, payload: HostKeyTrustPayload): Promise<void> {
  const body = hostKeyTrustRequestBody(payload);

  const res = await fetch(`/api/org/${orgId}/ssh-host-keys/trust`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) return;

  const racePayload = await tryParseHostKeyTrustResponse(res);
  if (racePayload) {
    const err = new Error(
      "The host key changed again while you were accepting it. Please review and retry.",
    );
    (err as Error & { trustPayload?: HostKeyTrustPayload }).trustPayload = racePayload;
    throw err;
  }

  const text = await res.text();
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const errField = (parsed as { error?: unknown }).error;
      if (typeof errField === "string") message = errField;
    }
  } catch {
    /* keep raw text */
  }
  throw new Error(message || `Failed to trust host key (HTTP ${res.status})`);
}
