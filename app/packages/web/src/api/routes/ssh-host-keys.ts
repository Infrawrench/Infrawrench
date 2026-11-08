/**
 * The host-key trust 409 for the Hono routes that still answer it (the SSH
 * install under `resource-detail/`). The trust API itself is on HttpApi
 * (`http/domains/ssh-host-keys/`), and the body is built once, in
 * `http/domains/ssh-host-key-trust.ts`, for both. Delete this file once the
 * last Hono caller has moved.
 */
import type { Context } from "hono";
import type { HostKeyTrustRequiredError } from "../../services/ssh-host-keys";
import { hostKeyTrustBody } from "../../http/domains/ssh-host-key-trust";

/**
 * Clients (web frontend, desktop cloud-proxy) recognize
 * `error === "ssh_host_key_trust_required"` and prompt the user.
 */
export function hostKeyTrustResponse(c: Context, err: HostKeyTrustRequiredError) {
  return c.json(hostKeyTrustBody(err), 409);
}
