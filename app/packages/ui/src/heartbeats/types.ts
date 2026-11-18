// The wire types come from `@infrawrench/client-core` (the shared pure half);
// this module only adds the client seam a host must provide.
import type {
  Heartbeat,
  HeartbeatCreate,
  HeartbeatPatch,
  HeartbeatPing,
  HeartbeatSuggestion,
} from "@infrawrench/client-core";

/**
 * What a host must provide for the heartbeat surfaces. The write methods are
 * optional: their absence renders the panels read-only, the `ProbesClient`
 * convention. Hosts return `pingUrl` absolute (the server may send a path
 * when it does not know its own public address).
 */
export interface HeartbeatsClient {
  listHeartbeats(): Promise<Heartbeat[]>;
  /** Scheduled resources, or one resource's schedule when `resourceId` is given. */
  listSuggestions(resourceId?: string): Promise<HeartbeatSuggestion[]>;
  /** Recent pings, newest first. */
  listPings(heartbeatId: string): Promise<HeartbeatPing[]>;
  createHeartbeat?(input: HeartbeatCreate): Promise<Heartbeat | null>;
  updateHeartbeat?(heartbeatId: string, patch: HeartbeatPatch): Promise<Heartbeat | null>;
  deleteHeartbeat?(heartbeatId: string): Promise<void>;
  rotateToken?(heartbeatId: string): Promise<Heartbeat | null>;
}

/** What the editor is opened with when it starts from a scheduled resource. */
export interface HeartbeatSeed {
  name: string;
  suggestion: HeartbeatSuggestion;
}
