/**
 * The `console:attach` handshake on the shared `/api/ws` socket.
 *
 * A guest reaches a shared console in two steps, and both of them check. The
 * HTTP `POST …/join` decides admission (invite, membership, permission) and
 * writes the participant row; this, on the socket, decides it again from the
 * live state before a single byte of somebody else's production terminal is
 * fanned out. The duplication is deliberate: the two calls are seconds apart,
 * they can land on different replicas, and the thing in between is a shell.
 */
import type { WebSocket } from "ws";

import { evaluateAttached } from "@infrawrench/server-core/shared-console/arbitration";
import {
  getParticipant,
  getSharedConsole,
  listParticipants,
  touchParticipant,
} from "@infrawrench/server-core/shared-console/store";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";

import { sharedConsoleHub } from "./hub";

function send(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/**
 * Attach `auth`'s socket to the shared console `sharedConsoleId`.
 *
 * Every refusal is a typed `console:error` with a `code`, because the client
 * has to distinguish "you cannot be here" (stop, show why) from "the session
 * is not on this replica" (retry on a fresh socket, which the ingress may hash
 * elsewhere). A generic failure would make the second look like the first and
 * strand a guest who is one reconnect away from working.
 */
export async function handleConsoleAttach(
  ws: WebSocket,
  auth: { organizationId: string; userId: string },
  sharedConsoleId: string,
): Promise<void> {
  const share = await getSharedConsole(sharedConsoleId);
  if (!share || share.organizationId !== auth.organizationId) {
    send(ws, { type: "console:error", code: "not_found", error: "Shared console not found." });
    return;
  }

  const participant = await getParticipant(share.id, auth.userId);
  if (!participant || participant.status !== "joined") {
    send(ws, {
      type: "console:error",
      code: "not_participant",
      error: "Join this console from its invite link first.",
    });
    return;
  }

  // Re-derived here, not carried over from the join call: the whole point of
  // `evaluateAttached` is that authority is a live fact.
  const access = await resolveEffectivePermissions(share.organizationId, {
    kind: "user",
    userId: auth.userId,
  });
  const verdict = evaluateAttached({
    share: {
      id: share.id,
      organizationId: share.organizationId,
      status: share.status,
      ownerUserId: share.ownerUserId,
      allowHandover: share.allowHandover,
      inviteTokenHash: null,
      inviteExpiresAt: share.inviteExpiresAt,
      inviteConsumedAt: share.inviteConsumedAt,
    },
    participant: {
      id: participant.id,
      userId: participant.userId,
      role: participant.role,
      status: participant.status,
    },
    permissions: access.permissions,
  });
  if (!verdict.keep) {
    send(ws, { type: "console:error", code: verdict.reason, error: verdict.message });
    return;
  }

  const participants = await listParticipants(share.id);
  const attached = sharedConsoleHub.attach({
    ws,
    liveConsoleId: share.liveConsoleId,
    share,
    participant,
    participants,
  });
  if (!attached.ok) {
    send(ws, {
      type: "console:error",
      code: attached.code,
      error:
        attached.code === "console_not_here"
          ? "This session is being served by another server instance. Reconnecting…"
          : "That session is no longer shared.",
      // The client uses this to ask the load balancer for the same backend on
      // its next attempt.
      routingKey: share.routingKey,
    });
    return;
  }

  void touchParticipant(participant.id).catch(() => undefined);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      if (!msg.type.startsWith("console:")) return;
      sharedConsoleHub.handleAttachedMessage(share.liveConsoleId, participant.id, msg);
    } catch {
      /* ignore malformed frames */
    }
  });
}
