/**
 * Shared consoles (org-scoped, mounted at /api/org/:orgId/shared-consoles).
 *
 * ## The trust model, in one place
 *
 * Sharing a console does not create a capability. Everyone on one — the person
 * who opened it and everyone they invite — must independently hold
 * `resources:execute` in this organization, which is the same permission the
 * WebSocket gateway requires to open a terminal at all. The invite link says
 * *which* session; it never says *whether*. That is why there is no
 * `shared-consoles:*` permission family: a new family would imply a share is a
 * lesser thing than a shell, and it is not — a guest can be handed the
 * keyboard, and is watching every byte regardless.
 *
 * Three consequences worth stating out loud, because they are the questions a
 * security review asks:
 *
 * - **A stolen link is not access.** Redeeming it still requires a signed-in
 *   member of this org holding `resources:execute`. Take that permission away
 *   from a role and both the direct terminal and every join disappear with it.
 * - **Authority is re-checked, not remembered.** `POST /join` checks, the
 *   socket's `console:attach` checks again, and the hub re-derives every
 *   participant's permissions on a sweep while they are attached.
 * - **Revocation is the owner's, and the org's.** The sharer can pull the plug;
 *   so can anyone holding `org:settings:write`, because a live session on a
 *   production box that only its author can stop is not a control anybody will
 *   accept.
 *
 * Every join, leave, role change, handover and revocation is audit-logged with
 * the resource and both actors.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  evaluateHandover,
  evaluateHandoverRequest,
  evaluateJoin,
  evaluateOwnerAction,
  type ConsoleDenial,
} from "@infrawrench/server-core/shared-console/arbitration";
import {
  DEFAULT_INVITE_TTL_MINUTES,
  DriverRaceLostError,
  InviteRaceLostError,
  MAX_INVITE_TTL_MINUTES,
  MIN_INVITE_TTL_MINUTES,
  admitParticipant,
  closeSharedConsole,
  createSharedConsole,
  detachParticipant,
  getInviteHash,
  getParticipant,
  getParticipantById,
  getSharedConsole,
  hashInviteSecret,
  listActiveSharedConsoles,
  listParticipants,
  parseInviteToken,
  replaceInvite,
  requestDriver,
  setDriver,
  withdrawInvite,
  type ParticipantRow,
  type SharedConsoleRow,
} from "@infrawrench/server-core/shared-console/store";

import { hasPermission } from "@infrawrench/server-core/permissions/catalog";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import {
  publicParticipant,
  publicShare,
  sharedConsoleHub,
} from "../../services/shared-console/hub";
import type { AuthSession } from "../auth-middleware";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

function actorId(c: Context): string {
  return (c.get("session") as AuthSession).userId;
}

/** The caller's effective permissions, as the org middleware already resolved them. */
function callerPermissions(c: Context): readonly string[] {
  return (c.get("permissions") as readonly string[] | undefined) ?? [];
}

function caller(c: Context) {
  return { userId: actorId(c), organizationId: orgId(c), permissions: callerPermissions(c) };
}

/** Turn an arbitration denial into the HTTP response it describes. */
function denied(c: Context, d: ConsoleDenial) {
  return c.json({ error: d.message, code: d.reason }, d.status);
}

function shareState(share: SharedConsoleRow, inviteTokenHash: string | null) {
  return {
    id: share.id,
    organizationId: share.organizationId,
    status: share.status,
    ownerUserId: share.ownerUserId,
    allowHandover: share.allowHandover,
    inviteTokenHash,
    inviteExpiresAt: share.inviteExpiresAt,
    inviteConsumedAt: share.inviteConsumedAt,
  };
}

function participantState(p: ParticipantRow) {
  return { id: p.id, userId: p.userId, role: p.role, status: p.status };
}

/** The share plus its people, which is what every mutating route returns. */
async function stateResponse(share: SharedConsoleRow) {
  const participants = await listParticipants(share.id);
  return {
    share: publicShare(share),
    participants: participants.filter((p) => p.status !== "left").map(publicParticipant),
  };
}

/**
 * Audit metadata every event on a share carries.
 *
 * Deliberately includes the host and the resource as well as the ids: the
 * question an investigator asks is "who had a shell on *that box*", and an
 * entry that only names a share id is one join away from answering it.
 */
function shareAuditMetadata(share: SharedConsoleRow, extra: Record<string, unknown> = {}) {
  return {
    sharedConsoleId: share.id,
    host: share.host,
    username: share.username,
    ...(share.accountId ? { accountId: share.accountId } : {}),
    ...(share.resourceId ? { resourceId: share.resourceId } : {}),
    ...(share.recordingId ? { recordingId: share.recordingId } : {}),
    ownerUserId: share.ownerUserId,
    ...extra,
  };
}

// ------------------------------------------------------------------ listing

/** GET / — shares currently live in this org. */
app.get("/", async (c) => {
  requirePermission(c, "resources:execute");
  const shares = await listActiveSharedConsoles(orgId(c));
  const withPeople = await Promise.all(
    shares.map(async (share) => ({
      ...publicShare(share),
      participants: (await listParticipants(share.id))
        .filter((p) => p.status === "joined")
        .map(publicParticipant),
    })),
  );
  return c.json(withPeople);
});

// ----------------------------------------------------------------- creating

const createSchema = z
  .object({
    /**
     * The pty to share, as the WebSocket reported it in `ssh:connected`.
     * Everything else about the session — which host, which account, which
     * recording — is read from the proxy's own registration rather than from
     * this body.
     */
    liveConsoleId: z.string().uuid(),
    routingKey: z.string().min(8).max(128),
    allowHandover: z.boolean().optional(),
    inviteTtlMinutes: z
      .number()
      .int()
      .min(MIN_INVITE_TTL_MINUTES)
      .max(MAX_INVITE_TTL_MINUTES)
      .optional(),
  })
  .strict();

/**
 * POST / — share a live session, and mint the first invite.
 *
 * Refuses when the pty is not registered on *this* replica, which is the
 * cross-replica caveat the hub's module comment describes. That refusal is the
 * honest one: writing the share row anyway would produce a link that resolves,
 * authorises correctly, and then finds nothing to attach to.
 */
app.post("/", async (c) => {
  requirePermission(c, "resources:execute");
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }

  const live = sharedConsoleHub.describe(parsed.data.liveConsoleId);
  if (!live) {
    return c.json(
      {
        error:
          "That terminal session is not held by this server. Reopen the terminal and share again.",
        code: "console_not_here",
      },
      409,
    );
  }
  if (live.organizationId !== orgId(c) || live.ownerUserId !== actorId(c)) {
    // Not 403: telling somebody they guessed a valid console id belonging to
    // another person is itself information.
    return c.json({ error: "That terminal session was not found.", code: "not_found" }, 404);
  }
  if (live.alreadyShared) {
    const existing = await getSharedConsole(live.alreadyShared);
    if (existing && existing.status === "active") {
      return c.json({ error: "This session is already shared.", code: "already_shared" }, 409);
    }
  }

  const { share, owner, invite } = await createSharedConsole({
    organizationId: orgId(c),
    liveConsoleId: parsed.data.liveConsoleId,
    routingKey: parsed.data.routingKey,
    ownerUserId: actorId(c),
    accountId: live.accountId,
    resourceId: live.resourceId,
    host: live.host,
    port: live.port,
    username: live.username,
    recordingId: live.recordingId ?? undefined,
    allowHandover: parsed.data.allowHandover ?? true,
    ptyCols: live.ptyCols,
    ptyRows: live.ptyRows,
    inviteTtlMinutes: parsed.data.inviteTtlMinutes ?? DEFAULT_INVITE_TTL_MINUTES,
  });

  const bound = await sharedConsoleHub.bindShare(parsed.data.liveConsoleId, share, owner);
  if (!bound) {
    // The session closed between `describe` and here.
    await closeSharedConsole(share.id, "ended");
    return c.json({ error: "That terminal session ended.", code: "console_not_here" }, 409);
  }

  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "shared_console.created",
    entityType: "shared-console",
    entityId: share.id,
    metadata: shareAuditMetadata(share, {
      allowHandover: share.allowHandover,
      inviteExpiresAt: share.inviteExpiresAt?.toISOString() ?? null,
    }),
  });

  return c.json({
    ...(await stateResponse(share)),
    // The only time the token is ever returned. It is not stored in plaintext
    // and cannot be shown again; the owner mints a replacement instead.
    inviteToken: invite.token,
  });
});

// ------------------------------------------------------------------ reading

/**
 * GET /:id — the share and its people.
 *
 * Visible to participants and to anyone who could revoke it. Deliberately not
 * to every member with `resources:execute`: knowing that a named colleague has
 * a root shell open on a named production host, right now, is operational
 * information, and the list route above is the place that answers it for
 * people who are entitled to the whole picture.
 */
app.get("/:id", async (c) => {
  requirePermission(c, "resources:execute");
  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);
  const me = await getParticipant(share.id, actorId(c));
  const owner = evaluateOwnerAction({
    share: shareState(share, null),
    actor: caller(c),
    isOrgAdmin: hasOrgAdmin(c),
  });
  if (!me && !owner.ok) return c.json({ error: "Not found" }, 404);
  return c.json(await stateResponse(share));
});

/**
 * GET /invites/:token — what a join link points at, before joining.
 *
 * The join screen has to say "you are about to watch root@db-prod-1, shared by
 * Priya" before anyone commits, and it has to say it to somebody who is not
 * yet a participant. So this route is reachable with a valid token — but only
 * by a signed-in member who already holds `resources:execute`, and it returns
 * the host, the sharer and the session's shape, never anything from the
 * session itself.
 */
app.get("/invites/:token", async (c) => {
  requirePermission(c, "resources:execute");
  const parsedToken = parseInviteToken(c.req.param("token"));
  if (!parsedToken) return c.json({ error: "That invite link is not valid." }, 404);
  const share = await getSharedConsole(parsedToken.shareId);
  if (!share || share.organizationId !== orgId(c)) {
    return c.json({ error: "That invite link is not valid." }, 404);
  }
  const existing = await getParticipant(share.id, actorId(c));
  const decision = evaluateJoin({
    share: shareState(share, await getInviteHash(share.id)),
    caller: caller(c),
    presentedTokenHash: hashInviteSecret(parsedToken.secret),
    existing: existing ? participantState(existing) : null,
    now: new Date(),
  });
  return c.json({
    share: publicShare(share),
    joinable: decision.ok,
    ...(decision.ok
      ? { rejoin: decision.rejoin }
      : { error: decision.message, code: decision.reason }),
  });
});

// ------------------------------------------------------------------- joining

const joinSchema = z.object({ token: z.string().min(1).max(200) }).strict();

/**
 * POST /:id/join — redeem an invite and become a participant.
 *
 * The invite is consumed by the first person it admits and by nobody
 * afterwards; somebody already on the share resumes their own row without a
 * token, so a reload does not cost them the session. See `evaluateJoin`, which
 * is where both of those are actually decided.
 */
app.post("/:id/join", async (c) => {
  requirePermission(c, "resources:execute");
  const parsed = joinSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "An invite token is required." }, 400);

  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);

  const parsedToken = parseInviteToken(parsed.data.token);
  if (parsedToken && parsedToken.shareId !== share.id) {
    return c.json({ error: "That invite link is for a different session." }, 403);
  }

  const existing = await getParticipant(share.id, actorId(c));
  const decision = evaluateJoin({
    share: shareState(share, await getInviteHash(share.id)),
    caller: caller(c),
    presentedTokenHash: parsedToken ? hashInviteSecret(parsedToken.secret) : null,
    existing: existing ? participantState(existing) : null,
    now: new Date(),
  });
  if (!decision.ok) return denied(c, decision);

  let participant: ParticipantRow;
  try {
    participant = await admitParticipant({
      share,
      userId: actorId(c),
      role: decision.role,
      consumesInvite: decision.consumesInvite,
    });
  } catch (err) {
    if (err instanceof InviteRaceLostError) {
      return c.json({ error: err.message, code: "invite-consumed" }, 403);
    }
    throw err;
  }

  if (!decision.rejoin) {
    await logAudit({
      organizationId: orgId(c),
      userId: actorId(c),
      action: "shared_console.join",
      entityType: "shared-console",
      entityId: share.id,
      metadata: shareAuditMetadata(share, {
        participantId: participant.id,
        role: participant.role,
      }),
    });
    sharedConsoleHub.mark(share.id, `joined: ${participant.userName ?? participant.userId}`);
  }
  await sharedConsoleHub.refresh(share.id);

  return c.json({
    ...(await stateResponse(share)),
    you: publicParticipant(participant),
    // The affinity hint the guest's WebSocket must carry to reach the replica
    // holding the pty.
    routingKey: share.routingKey,
  });
});

/** POST /:id/leave — step off the console without ending it. */
app.post("/:id/leave", async (c) => {
  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);
  const me = await getParticipant(share.id, actorId(c));
  if (!me) return c.json({ error: "You are not on this shared console." }, 404);

  await detachParticipant(me.id, "left");
  sharedConsoleHub.detach(share.liveConsoleId, me.id, "removed", "You left this shared console.");
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "shared_console.leave",
    entityType: "shared-console",
    entityId: share.id,
    metadata: shareAuditMetadata(share, { participantId: me.id, wasDriver: me.role === "driver" }),
  });
  sharedConsoleHub.mark(share.id, `left: ${me.userName ?? me.userId}`);
  await sharedConsoleHub.refresh(share.id);
  return c.json(await stateResponse(share));
});

// ------------------------------------------------------------------ handover

const handoverSchema = z.object({ participantId: z.string().uuid() }).strict();

/**
 * POST /:id/handover — move the keyboard.
 *
 * Authorised by the current driver (it is theirs to give) or by the owner (it
 * is their box). Two simultaneous grants cannot both win: the partial unique
 * index on the participants table decides the order and the loser gets a 409.
 */
app.post("/:id/handover", async (c) => {
  requirePermission(c, "resources:execute");
  const parsed = handoverSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "A participantId is required." }, 400);

  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);

  const participants = await listParticipants(share.id);
  const target = participants.find((p) => p.id === parsed.data.participantId) ?? null;
  const mine = participants.find((p) => p.userId === actorId(c)) ?? null;
  const currentDriver =
    participants.find((p) => p.role === "driver" && p.status === "joined") ?? null;

  const decision = evaluateHandover({
    share: shareState(share, null),
    actor: caller(c),
    actorParticipant: mine ? participantState(mine) : null,
    target: target ? participantState(target) : null,
    currentDriver: currentDriver ? participantState(currentDriver) : null,
  });
  if (!decision.ok) return denied(c, decision);

  try {
    await setDriver({
      sharedConsoleId: share.id,
      demoteParticipantId: decision.demote,
      promoteParticipantId: decision.promote,
    });
  } catch (err) {
    if (err instanceof DriverRaceLostError) {
      return c.json({ error: err.message, code: "driver-race-lost" }, 409);
    }
    throw err;
  }

  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "shared_console.handover",
    entityType: "shared-console",
    entityId: share.id,
    metadata: shareAuditMetadata(share, {
      fromParticipantId: decision.demote,
      fromUserId: currentDriver?.userId ?? null,
      toParticipantId: decision.promote,
      toUserId: target?.userId ?? null,
      forced: decision.forced,
    }),
  });
  sharedConsoleHub.mark(
    share.id,
    `keyboard to ${target?.userName ?? target?.userId ?? "unknown"}${decision.forced ? " (forced by sharer)" : ""}`,
  );
  await sharedConsoleHub.refresh(share.id);
  return c.json(await stateResponse(share));
});

/**
 * POST /:id/request-driver — ask for the keyboard.
 *
 * Grants nothing. It sets a flag the driver and the owner can see, which is
 * the whole mechanism: an observer cannot promote themselves, and a request
 * that expired silently would be worse than one that sits there visibly.
 */
app.post("/:id/request-driver", async (c) => {
  requirePermission(c, "resources:execute");
  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);
  const mine = await getParticipant(share.id, actorId(c));
  const decision = evaluateHandoverRequest({
    share: shareState(share, null),
    actor: caller(c),
    actorParticipant: mine ? participantState(mine) : null,
  });
  if (!decision.ok) return denied(c, decision);
  await requestDriver(decision.participantId);
  await sharedConsoleHub.refresh(share.id);
  return c.json(await stateResponse(share));
});

// -------------------------------------------------------------- owner powers

/**
 * True when the caller may act on any share in the org, not only their own.
 *
 * `org:settings:write` rather than a new permission: pulling the plug on a
 * live session somebody else opened is an administrative act over the
 * organization, and the set of people who should hold it is the set that
 * already administers it.
 */
function hasOrgAdmin(c: Context): boolean {
  return hasPermission([...callerPermissions(c)], "org:settings:write");
}

const inviteSchema = z
  .object({
    inviteTtlMinutes: z
      .number()
      .int()
      .min(MIN_INVITE_TTL_MINUTES)
      .max(MAX_INVITE_TTL_MINUTES)
      .optional(),
  })
  .strict();

/** POST /:id/invites — mint a replacement invite (the last one is dead). */
app.post("/:id/invites", async (c) => {
  const parsed = inviteSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);
  const allowed = evaluateOwnerAction({
    share: shareState(share, null),
    actor: caller(c),
    isOrgAdmin: hasOrgAdmin(c),
  });
  if (!allowed.ok) return denied(c, allowed);
  if (share.status !== "active") {
    return c.json({ error: "This shared console is no longer live." }, 409);
  }
  const invite = await replaceInvite(
    share.id,
    parsed.data.inviteTtlMinutes ?? DEFAULT_INVITE_TTL_MINUTES,
  );
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "shared_console.invite.created",
    entityType: "shared-console",
    entityId: share.id,
    metadata: shareAuditMetadata(share, { inviteExpiresAt: invite.expiresAt.toISOString() }),
  });
  const refreshed = (await getSharedConsole(share.id))!;
  await sharedConsoleHub.refresh(share.id);
  return c.json({ ...(await stateResponse(refreshed)), inviteToken: invite.token });
});

/** DELETE /:id/invites — withdraw the outstanding link without ending the share. */
app.delete("/:id/invites", async (c) => {
  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);
  const allowed = evaluateOwnerAction({
    share: shareState(share, null),
    actor: caller(c),
    isOrgAdmin: hasOrgAdmin(c),
  });
  if (!allowed.ok) return denied(c, allowed);
  await withdrawInvite(share.id);
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "shared_console.invite.withdrawn",
    entityType: "shared-console",
    entityId: share.id,
    metadata: shareAuditMetadata(share),
  });
  const refreshed = (await getSharedConsole(share.id))!;
  await sharedConsoleHub.refresh(share.id);
  return c.json(await stateResponse(refreshed));
});

/**
 * DELETE /:id/participants/:participantId — eject somebody.
 *
 * `removed`, not `left`: an ejected guest cannot resume on their own row and
 * needs a fresh invite. Their socket goes immediately on the replica holding
 * the pty, and within one sweep on the other.
 */
app.delete("/:id/participants/:participantId", async (c) => {
  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);
  const allowed = evaluateOwnerAction({
    share: shareState(share, null),
    actor: caller(c),
    isOrgAdmin: hasOrgAdmin(c),
  });
  if (!allowed.ok) return denied(c, allowed);

  const target = await getParticipantById(c.req.param("participantId"));
  if (!target || target.sharedConsoleId !== share.id) return c.json({ error: "Not found" }, 404);
  if (target.userId === share.ownerUserId) {
    return c.json({ error: "The sharer cannot be removed; revoke the share instead." }, 409);
  }

  await detachParticipant(target.id, "removed");
  sharedConsoleHub.detach(
    share.liveConsoleId,
    target.id,
    "removed",
    "You were removed from this shared console.",
  );
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "shared_console.participant.removed",
    entityType: "shared-console",
    entityId: share.id,
    metadata: shareAuditMetadata(share, {
      participantId: target.id,
      removedUserId: target.userId,
      wasDriver: target.role === "driver",
    }),
  });
  sharedConsoleHub.mark(share.id, `removed: ${target.userName ?? target.userId}`);
  await sharedConsoleHub.refresh(share.id);
  return c.json(await stateResponse(share));
});

/**
 * DELETE /:id — revoke the share. The SSH session itself carries on.
 *
 * Note what this route does *not* require: `resources:execute`. Ending access
 * must never be gated on still holding the access, or an owner whose role was
 * narrowed mid-incident would be locked out of closing the session they
 * opened. Same reasoning as `leave`.
 */
app.delete("/:id", async (c) => {
  const share = await getSharedConsole(c.req.param("id"));
  if (!share || share.organizationId !== orgId(c)) return c.json({ error: "Not found" }, 404);
  const allowed = evaluateOwnerAction({
    share: shareState(share, null),
    actor: caller(c),
    isOrgAdmin: hasOrgAdmin(c),
  });
  if (!allowed.ok) return denied(c, allowed);

  const closed = await closeSharedConsole(share.id, "revoked", actorId(c));
  // Immediate on this replica; within one 2s sweep on the other.
  sharedConsoleHub.revokeLocal(share.id);
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "shared_console.revoked",
    entityType: "shared-console",
    entityId: share.id,
    metadata: shareAuditMetadata(share, {
      byOwner: share.ownerUserId === actorId(c),
      alreadyClosed: closed === null,
    }),
  });
  return c.json({ ok: true });
});

export default app;
