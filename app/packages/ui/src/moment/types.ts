/**
 * The moment-view contract lives in client-core so mobile (which doesn't
 * depend on this package) shares one definition; the package index re-exports
 * it for web and desktop the same way the change-timeline types are.
 */
import type { MomentRequest, MomentResponse } from "@infrawrench/client-core";

/**
 * Host-injected data access for the moment view. Web wraps `apiGet`; desktop
 * (cloud mode) wraps its cloud IPC — the panel stays platform-agnostic, the
 * same arrangement as `ChangesClient`.
 */
export interface MomentClient {
  getMoment(request: MomentRequest): Promise<MomentResponse>;
}
