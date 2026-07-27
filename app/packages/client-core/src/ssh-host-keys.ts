/**
 * The SSH host-key trust handshake, shared by every host that can open an SSH
 * session.
 *
 * Two transports carry the same refusal. HTTP routes (SFTP, tunnels, connect)
 * answer 409 with `{ error: "ssh_host_key_trust_required", … }`; the WebSocket
 * proxy sends an `ssh:error` frame with `code` set to the same string and the
 * fields spread across the frame. Either way the client shows the presented
 * fingerprint, POSTs /ssh-host-keys/trust if the operator accepts, and retries.
 */

export interface HostKeyTrustPayload {
  error: "ssh_host_key_trust_required";
  message: string;
  kind: "unknown" | "mismatch";
  host: string;
  port: number;
  presentedFingerprint: string;
  storedFingerprint: string | null;
}

/**
 * Structural type guard. Accepts any object whose `error` discriminant
 * matches the trust-required string and which carries the fields the dialog
 * needs to render.
 */
export function isHostKeyTrustResponse(body: unknown): body is HostKeyTrustPayload {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b.error !== "ssh_host_key_trust_required") return false;
  if (b.kind !== "unknown" && b.kind !== "mismatch") return false;
  if (typeof b.host !== "string" || b.host.length === 0) return false;
  if (typeof b.port !== "number") return false;
  if (typeof b.presentedFingerprint !== "string" || b.presentedFingerprint.length === 0) {
    return false;
  }
  if (b.storedFingerprint !== null && typeof b.storedFingerprint !== "string") return false;
  return true;
}

/**
 * Build a trust payload from an `ssh:error` WebSocket frame, or null when the
 * frame is an ordinary error. The proxy spreads the fields across the frame
 * and marks it with `code`, where the HTTP routes use `error` — this is the
 * one place that difference is handled.
 */
export function trustPayloadFromFrame(frame: unknown): HostKeyTrustPayload | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.code !== "ssh_host_key_trust_required") return null;
  const candidate = {
    error: "ssh_host_key_trust_required",
    message: typeof f.error === "string" ? f.error : "SSH host key requires trust",
    kind: f.kind,
    host: f.host,
    port: f.port,
    presentedFingerprint: f.presentedFingerprint,
    storedFingerprint: f.storedFingerprint ?? null,
  };
  return isHostKeyTrustResponse(candidate) ? candidate : null;
}

/**
 * Request body for `POST /api/org/:orgId/ssh-host-keys/trust`.
 * `previousFingerprint` is what turns the audit entry from "trusted" into
 * "replaced", so it is sent whenever we are overwriting a pin.
 */
export function hostKeyTrustRequestBody(payload: HostKeyTrustPayload): Record<string, unknown> {
  return {
    host: payload.host,
    port: payload.port,
    fingerprint: payload.presentedFingerprint,
    ...(payload.storedFingerprint ? { previousFingerprint: payload.storedFingerprint } : {}),
  };
}

/** Human-readable `host` or `host:port`, matching how the dialogs label a host. */
export function hostKeyLabel(payload: { host: string; port: number }): string {
  return payload.port === 22 ? payload.host : `${payload.host}:${payload.port}`;
}
