/**
 * Turning the SSH services' host-key refusal into the 409 clients prompt on.
 *
 * `HostKeyTrustRequiredError` is thrown by every SSH dial (`sshExec`, SFTP,
 * `openTunnel`, the Linux app probe) when the host presents a key the org has
 * not pinned, or one that differs from the pin. The routes have always
 * answered it with one body, built here once: {@link hostKeyTrustBody} for a
 * caller that writes it itself (the app setup stream, whose status line has
 * already gone; the Hono routes still answering it), {@link hostKeyTrustRefusal}
 * for an HttpApi handler's `legacyTry`.
 */
import { HostKeyTrustRequiredError } from "../../services/ssh-host-keys";
import { SshHostKeyTrustRequired } from "../schemas/ssh-host-key-trust";

/** The fields a host-key refusal carries, as the service's error holds them. */
export interface HostKeyTrustFields {
  readonly message: string;
  readonly kind: "unknown" | "mismatch";
  readonly host: string;
  readonly port: number;
  readonly presentedFingerprint: string;
  readonly storedFingerprint: string | null;
}

/** The 409 body, in the key order clients have always received. */
export const hostKeyTrustBody = (error: HostKeyTrustFields) => ({
  error: "ssh_host_key_trust_required" as const,
  message: error.message,
  kind: error.kind,
  host: error.host,
  port: error.port,
  presentedFingerprint: error.presentedFingerprint,
  storedFingerprint: error.storedFingerprint,
});

/** The endpoint error for `error`, as a value. */
export const hostKeyTrustRequired = (error: HostKeyTrustFields) =>
  new SshHostKeyTrustRequired(hostKeyTrustBody(error));

/**
 * A `legacyTry` mapper: the 409 for a host-key refusal, `undefined` (stays a
 * defect) for anything else.
 */
export const hostKeyTrustRefusal = (error: unknown): SshHostKeyTrustRequired | undefined =>
  error instanceof HostKeyTrustRequiredError ? hostKeyTrustRequired(error) : undefined;
