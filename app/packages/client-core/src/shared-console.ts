/**
 * The shared-console wire contract, shared by every client that could speak it.
 *
 * Only web implements it today (see the deferral note in KNOWLEDGE.md — the
 * desktop terminal is a local ssh2 connection for local accounts and never
 * passes through the proxy that does the fanning-out, and a phone is not a
 * device you take the keyboard on). The types live here anyway, because the
 * moment a second client speaks this protocol the contract has to have one
 * home, and finding that out later means finding it out by drift.
 *
 * Pure types and pure functions: no fetch, no DOM, no sockets.
 */

/** What a participant may do on the console. */
export type SharedConsoleRole = "observer" | "driver";

export type SharedConsoleParticipantStatus = "joined" | "left" | "removed";

export type SharedConsoleStatus = "active" | "revoked" | "ended";

export interface SharedConsoleParticipant {
  id: string;
  userId: string;
  userName: string | null;
  role: SharedConsoleRole;
  status: SharedConsoleParticipantStatus;
  driverRequestedAt: string | null;
  joinedAt: string;
}

export interface SharedConsoleSummary {
  id: string;
  /** Load-balancer affinity hint. Never authorisation — see the API docs. */
  routingKey: string;
  ownerUserId: string | null;
  ownerName: string | null;
  accountId: string | null;
  resourceId: string | null;
  host: string;
  port: number;
  username: string;
  allowHandover: boolean;
  status: SharedConsoleStatus;
  inviteTokenPrefix: string | null;
  inviteExpiresAt: string | null;
  inviteConsumedAt: string | null;
  recordingId: string | null;
  ptyCols: number;
  ptyRows: number;
  createdAt: string;
}

export interface SharedConsoleState {
  share: SharedConsoleSummary;
  participants: SharedConsoleParticipant[];
}

export interface SharedConsoleCreated extends SharedConsoleState {
  /** Returned exactly once; only its digest is stored. */
  inviteToken: string;
}

export interface SharedConsoleJoined extends SharedConsoleState {
  you: SharedConsoleParticipant;
  routingKey: string;
}

export interface SharedConsoleInvitePreview {
  share: SharedConsoleSummary;
  joinable: boolean;
  rejoin?: boolean;
  error?: string;
  code?: string;
}

/** Frames a guest's socket sends. */
export type SharedConsoleClientFrame =
  | { type: "console:attach"; sharedConsoleId: string }
  | { type: "console:input"; data: string }
  | { type: "console:viewport"; cols: number; rows: number };

/** Frames the server sends to a guest, and (for state ones) to the sharer. */
export type SharedConsoleServerFrame =
  | { type: "console:attached"; participantId: string; role: SharedConsoleRole; ptySize: PtySize }
  | {
      type: "console:state";
      share: SharedConsoleSummary;
      participants: SharedConsoleParticipant[];
      ptySize: PtySize;
    }
  | { type: "console:data"; data: string }
  | { type: "console:pty-size"; cols: number; rows: number }
  | { type: "console:detached"; reason: string; message: string }
  | { type: "console:ended"; reason: string }
  | { type: "console:error"; code: string; error: string; routingKey?: string };

export interface PtySize {
  cols: number;
  rows: number;
}

/**
 * A fresh affinity hint for a terminal that might later be shared.
 *
 * Minted client-side, before the socket opens, because it has to be in the
 * upgrade URL and the server has not seen the session yet. It is a routing
 * key and nothing else — 128 bits so two concurrent sessions never collide
 * onto the same hash bucket by accident, not because guessing it would gain
 * anybody anything.
 */
export function mintRoutingKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The scale at which `ptySize` fits inside `viewport`, capped at 1.
 *
 * This is the letterboxing rule. A shared pty has exactly one geometry and it
 * is the driver's; everyone else renders that geometry scaled down to fit,
 * with bars around it, rather than reflowing to their own window. Reflowing
 * would show the observer a screen the driver is not looking at — which for a
 * full-screen editor or a `top` is not a cosmetic difference — and resizing
 * the pty to suit them would let anybody watching shrink the terminal of the
 * person actually fixing production.
 *
 * Capped at 1 because scaling *up* a terminal to fill a large window makes
 * text soft for no benefit; a smaller pty simply sits centred.
 */
export function letterboxScale(
  ptyPixels: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (ptyPixels.width <= 0 || ptyPixels.height <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(1, viewport.width / ptyPixels.width, viewport.height / ptyPixels.height);
}

/** "in 12 min" / "in 48s" / "expired" — the invite countdown. */
export function formatInviteExpiry(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return "no open invite";
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms)) return "no open invite";
  if (ms <= 0) return "expired";
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `expires in ${seconds}s`;
  return `expires in ${Math.round(seconds / 60)} min`;
}

/** The driver on a participant list, or null while nobody holds the keyboard. */
export function currentDriver(
  participants: readonly SharedConsoleParticipant[],
): SharedConsoleParticipant | null {
  return participants.find((p) => p.role === "driver" && p.status === "joined") ?? null;
}
