/**
 * The moment-view contract lives in client-core so mobile (which doesn't
 * depend on this package) shares one definition; re-exported for web and
 * desktop the same way the change-timeline types are.
 */
export type {
  MomentEvent,
  MomentEventLink,
  MomentFeedId,
  MomentFeedStatus,
  MomentIncidentSpan,
  MomentRequest,
  MomentResponse,
  MomentSeverity,
  MomentTimelineItem,
} from "@infrawrench/client-core";

import type { MomentRequest, MomentResponse } from "@infrawrench/client-core";

/**
 * Host-injected data access for the moment view. Web wraps `apiGet`; desktop
 * (cloud mode) wraps its cloud IPC — the panel stays platform-agnostic, the
 * same arrangement as `ChangesClient`.
 */
export interface MomentClient {
  getMoment(request: MomentRequest): Promise<MomentResponse>;
}
