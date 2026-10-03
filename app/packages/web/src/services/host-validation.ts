/**
 * SSRF protection for destinations the server dials on a tenant's behalf.
 *
 * The policy and the address normalisation live in server-core's
 * `egress-guard`, shared with the poller and every driver and plugin HTTP
 * path; this module keeps the name the SSH routes have always imported.
 *
 * {@link resolveSafeHost} returns the address it cleared on purpose. A
 * caller that validates a name and then hands the same *name* to ssh2 has
 * only bought a second DNS lookup for an attacker to answer differently. A
 * function that returns the address it cleared makes ignoring that address a
 * visible choice, which is the whole difference between a check and a guard.
 */
export { resolveSafeHost } from "@infrawrench/server-core/egress-guard";
