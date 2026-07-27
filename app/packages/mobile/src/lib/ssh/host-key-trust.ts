import { isHostKeyTrustResponse, type HostKeyTrustPayload } from "@infrawrench/client-core";

/**
 * Registry connecting the two places a host-key refusal can surface to the one
 * place that can ask the operator about it.
 *
 * The refusal arrives either as an HTTP 409 (SFTP, tunnels — intercepted by
 * `CloudFetch`'s `on409` hook, which lives below the React tree) or as an
 * `ssh:error` frame in the terminal. Neither can render a modal, so
 * `HostKeyTrustHost` registers the prompt here at mount and both call into it.
 *
 * Deliberately module-level: the 409 interceptor is constructed inside
 * `AuthProvider`, above any component that could hold this in context, and a
 * React context would be unreachable from there.
 */

type TrustPrompt = (payload: HostKeyTrustPayload) => Promise<boolean>;

let activePrompt: TrustPrompt | null = null;
let trustInFlight = false;

/** Called by `HostKeyTrustHost` on mount; pass null on unmount. */
export function registerHostKeyTrustPrompt(prompt: TrustPrompt | null): void {
  activePrompt = prompt;
}

/**
 * Ask the operator to trust `payload`. Resolves true once the fingerprint is
 * pinned, false if they declined — or if nothing is mounted to ask, in which
 * case the caller reports the refusal as an ordinary error.
 */
export function requestHostKeyTrust(payload: HostKeyTrustPayload): Promise<boolean> {
  if (!activePrompt) return Promise.resolve(false);
  return activePrompt(payload);
}

/**
 * Mark the trust POST itself as in flight. That request can 409 in its own
 * right when a concurrent connect saw a different key, and letting the
 * interceptor retry it would replay the fingerprint the server just rejected —
 * forever. The sheet handles that race by re-prompting with the new payload.
 */
export function setTrustRequestInFlight(value: boolean): void {
  trustInFlight = value;
}

/**
 * `CloudFetch`'s `on409` hook: prompt on a trust-required conflict and report
 * whether the original request should be retried.
 */
export async function handleHostKeyTrustConflict(body: unknown): Promise<boolean> {
  if (trustInFlight) return false;
  if (!isHostKeyTrustResponse(body)) return false;
  return requestHostKeyTrust(body);
}
