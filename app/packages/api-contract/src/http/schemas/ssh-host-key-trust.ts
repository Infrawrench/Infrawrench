/**
 * The 409 every SSH-backed route answers when the host's key is not trusted
 * yet (or has changed): SFTP, tunnels, connect, Linux app checks and the trust
 * route itself. Clients (the web `withTrustPrompt`, the desktop's
 * `fetchWithHostKeyPrompt`) recognise `error === "ssh_host_key_trust_required"`,
 * prompt with the fingerprint, `POST /ssh-host-keys/trust` and retry, so the
 * body's fields and their order are a contract: `../domains/ssh-host-key-trust.ts`
 * builds it from the service's `HostKeyTrustRequiredError`.
 */
import { Schema } from "effect";

export class SshHostKeyTrustRequired extends Schema.Error<SshHostKeyTrustRequired>(
  "infrawrench/http/SshHostKeyTrustRequired",
)(
  {
    error: Schema.Literal("ssh_host_key_trust_required"),
    message: Schema.String,
    kind: Schema.Literals(["unknown", "mismatch"]),
    host: Schema.String,
    port: Schema.Int,
    presentedFingerprint: Schema.String,
    storedFingerprint: Schema.NullOr(Schema.String),
  },
  {
    httpApiStatus: 409,
    identifier: "SshHostKeyTrustRequired",
    description: "The host key is new or has changed; trust it and retry",
  },
) {}
