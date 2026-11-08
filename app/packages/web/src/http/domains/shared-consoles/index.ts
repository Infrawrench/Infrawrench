/**
 * Shared consoles: `/api/org/:orgId/shared-consoles`, the handlers.
 *
 * ## The trust model, in one place
 *
 * Sharing a console does not create a capability. Everyone on one (the person
 * who opened it and everyone they invite) must independently hold
 * `resources:execute` in this organization, which is the same permission the
 * WebSocket gateway requires to open a terminal at all. The invite link says
 * *which* session; it never says *whether*.
 *
 * - **A stolen link is not access.** Redeeming it still requires a signed-in
 *   member of this org holding `resources:execute`.
 * - **Authority is re-checked, not remembered.** `POST /join` checks, the
 *   socket's `console:attach` checks again, and the hub re-derives every
 *   participant's permissions on a sweep while they are attached.
 * - **Revocation is the owner's, and the org's.** The sharer can pull the plug;
 *   so can anyone holding `org:settings:write`.
 *
 * The share rows are in Postgres, the pty and its fan-out in this process
 * (`services/shared-console/`), which is why the surface is on the session
 * gateway. Every join, leave, role change, handover and revocation is
 * audit-logged with the resource and both actors.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
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
import {
  badRequest,
  conflict,
  CreateSharedConsole,
  forbidden,
  HandoverSharedConsole,
  JoinSharedConsole,
  MintSharedConsoleInvite,
  notFound,
  ok,
  SharedConsoleCreated,
  SharedConsoleInvitePreview,
  SharedConsoleJoined,
  SharedConsolesApi,
  SharedConsoleState,
  SharedConsoleSummary,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { publicParticipant, publicShare } from "../../../services/shared-console/hub";
import * as consoleRelay from "../../../services/shared-console/relay";
import { makeDomain } from "../../domain";
import { readJsonOr, decodeFirstIssue } from "../../request-body";
import { legacy } from "../../legacy";
import { json } from "../../middleware";
import { OrgPrincipal, type OrgPrincipalValue } from "../../principal";
import { respond } from "../../response";

/** A synchronous relay call, inside the request's scopes like every other one. */
const relay = (fn: () => void) => legacy(() => Promise.resolve(fn()));

/** A refusal carrying a machine-readable `code` beside the sentence, as the routes sent it. */
const refusal = (status: number, error: string, code: string) => json({ error, code }, status);

/** An arbitration denial as the response it describes. */
const denied = (d: ConsoleDenial) => refusal(d.status, d.message, d.reason);

function caller(principal: OrgPrincipalValue) {
  return {
    userId: principal.session.userId,
    organizationId: principal.organizationId,
    permissions: principal.permissions,
  };
}

/**
 * True when the caller may act on any share in the org, not only their own.
 * `org:settings:write` rather than a new permission: pulling the plug on a
 * live session somebody else opened is an administrative act over the
 * organization, and the people who should hold it already administer it.
 */
const isOrgAdmin = (principal: OrgPrincipalValue) =>
  hasPermission([...principal.permissions], "org:settings:write");

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
const stateOf = (share: SharedConsoleRow) =>
  legacy(async () => {
    const participants = await listParticipants(share.id);
    return {
      share: publicShare(share),
      participants: participants.filter((p) => p.status !== "left").map(publicParticipant),
    };
  });

/**
 * Audit metadata every event on a share carries: the host and the resource as
 * well as the ids, since the question an investigator asks is "who had a
 * shell on *that box*".
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

/** The org's share `id`, or the 404 every route answers for one it cannot see. */
const orgShare = (organizationId: string, id: string) =>
  Effect.gen(function* () {
    const share = yield* legacy(() => getSharedConsole(id));
    if (!share || share.organizationId !== organizationId) return yield* notFound();
    return share;
  });

/** Whether the caller may act as the share's owner: they are the sharer, or administer the org. */
const ownerAction = (principal: OrgPrincipalValue, share: SharedConsoleRow) =>
  evaluateOwnerAction({
    share: shareState(share, null),
    actor: caller(principal),
    isOrgAdmin: isOrgAdmin(principal),
  });

const audit = (
  principal: OrgPrincipalValue,
  share: SharedConsoleRow,
  action: string,
  metadata: Record<string, unknown>,
) =>
  legacy(() =>
    logAudit({
      organizationId: principal.organizationId,
      userId: principal.session.userId,
      action,
      entityType: "shared-console",
      entityId: share.id,
      metadata,
    }),
  );

const SharedConsolesHandlers = HttpApiBuilder.group(
  SharedConsolesApi,
  "sharedConsoles",
  (handlers) =>
    handlers
      /** Shares currently live in this org. */
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const withPeople = yield* legacy(async () => {
            const shares = await listActiveSharedConsoles(organizationId);
            return Promise.all(
              shares.map(async (share) => ({
                ...publicShare(share),
                participants: (await listParticipants(share.id))
                  .filter((p) => p.status === "joined")
                  .map(publicParticipant),
              })),
            );
          });
          return yield* respond(Schema.Array(SharedConsoleSummary))(withPeople);
        }),
      )
      /**
       * Share a live session, and mint the first invite. Refuses when the pty is
       * not registered on *this* replica: writing the share row anyway would
       * produce a link that resolves, authorises correctly, and then finds
       * nothing to attach to.
       */
      .handleRaw("create", ({ request }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const { organizationId } = principal;
          const userId = principal.session.userId;
          const input = yield* decodeFirstIssue(
            CreateSharedConsole,
            yield* readJsonOr(request, null),
          );

          const live = yield* legacy(() => consoleRelay.describeConsole(input.liveConsoleId));
          if (!live) {
            return refusal(
              409,
              "That terminal session is not held by this server. Reopen the terminal and share again.",
              "console_not_here",
            );
          }
          if (live.organizationId !== organizationId || live.ownerUserId !== userId) {
            // Not 403: telling somebody they guessed a valid console id belonging
            // to another person is itself information.
            return refusal(404, "That terminal session was not found.", "not_found");
          }
          const alreadyShared = live.alreadyShared;
          if (alreadyShared) {
            const existing = yield* legacy(() => getSharedConsole(alreadyShared));
            if (existing && existing.status === "active") {
              return refusal(409, "This session is already shared.", "already_shared");
            }
          }

          const { share, owner, invite } = yield* legacy(() =>
            createSharedConsole({
              organizationId,
              liveConsoleId: input.liveConsoleId,
              routingKey: input.routingKey,
              ownerUserId: userId,
              accountId: live.accountId,
              resourceId: live.resourceId,
              host: live.host,
              port: live.port,
              username: live.username,
              recordingId: live.recordingId ?? undefined,
              allowHandover: input.allowHandover ?? true,
              ptyCols: live.ptyCols,
              ptyRows: live.ptyRows,
              inviteTtlMinutes: input.inviteTtlMinutes ?? DEFAULT_INVITE_TTL_MINUTES,
            }),
          );

          const bound = yield* legacy(() =>
            consoleRelay.bindShare(input.liveConsoleId, share, owner),
          );
          if (!bound) {
            // The session closed between `describe` and here.
            yield* legacy(() => closeSharedConsole(share.id, "ended"));
            return refusal(409, "That terminal session ended.", "console_not_here");
          }

          yield* audit(
            principal,
            share,
            "shared_console.created",
            shareAuditMetadata(share, {
              allowHandover: share.allowHandover,
              inviteExpiresAt: share.inviteExpiresAt?.toISOString() ?? null,
            }),
          );

          return yield* respond(SharedConsoleCreated)({
            ...(yield* stateOf(share)),
            // The only time the token is ever returned. It is not stored in
            // plaintext and cannot be shown again; the owner mints a replacement.
            inviteToken: invite.token,
          });
        }),
      )
      /**
       * What a join link points at, before joining: reachable with a valid token
       * by a signed-in member holding `resources:execute`, and returning the
       * host, the sharer and the session's shape, never anything from it.
       */
      .handle("invitePreview", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const parsedToken = parseInviteToken(params.token);
          if (!parsedToken) return yield* notFound("That invite link is not valid.");
          const share = yield* legacy(() => getSharedConsole(parsedToken.shareId));
          if (!share || share.organizationId !== principal.organizationId) {
            return yield* notFound("That invite link is not valid.");
          }
          const existing = yield* legacy(() => getParticipant(share.id, principal.session.userId));
          const inviteHash = yield* legacy(() => getInviteHash(share.id));
          const decision = evaluateJoin({
            share: shareState(share, inviteHash),
            caller: caller(principal),
            presentedTokenHash: hashInviteSecret(parsedToken.secret),
            existing: existing ? participantState(existing) : null,
            now: new Date(),
          });
          return yield* respond(SharedConsoleInvitePreview)({
            share: publicShare(share),
            joinable: decision.ok,
            ...(decision.ok
              ? { rejoin: decision.rejoin }
              : { error: decision.message, code: decision.reason }),
          });
        }),
      )
      /**
       * The share and its people. Visible to participants and to anyone who
       * could revoke it, deliberately not to every member with
       * `resources:execute`: the list route answers that for the entitled.
       */
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const me = yield* legacy(() => getParticipant(share.id, principal.session.userId));
          if (!me && !ownerAction(principal, share).ok) return yield* notFound();
          return yield* respond(SharedConsoleState)(yield* stateOf(share));
        }),
      )
      /**
       * Redeem an invite and become a participant. The invite is consumed by the
       * first person it admits; somebody already on the share resumes their own
       * row without a token. `evaluateJoin` is where both are decided.
       */
      .handleRaw("join", ({ params, request }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const userId = principal.session.userId;
          const body = yield* decodeFirstIssue(
            JoinSharedConsole,
            yield* readJsonOr(request, null),
          ).pipe(Effect.mapError(() => badRequest("An invite token is required.")));

          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const parsedToken = parseInviteToken(body.token);
          if (parsedToken && parsedToken.shareId !== share.id) {
            return yield* forbidden("That invite link is for a different session.");
          }

          const existing = yield* legacy(() => getParticipant(share.id, userId));
          const inviteHash = yield* legacy(() => getInviteHash(share.id));
          const decision = evaluateJoin({
            share: shareState(share, inviteHash),
            caller: caller(principal),
            presentedTokenHash: parsedToken ? hashInviteSecret(parsedToken.secret) : null,
            existing: existing ? participantState(existing) : null,
            now: new Date(),
          });
          if (!decision.ok) return denied(decision);

          const admitted = yield* legacy(() =>
            admitParticipant({
              share,
              userId,
              role: decision.role,
              consumesInvite: decision.consumesInvite,
            }).then(
              (participant) => ({ ok: true as const, participant }),
              (error: unknown) => {
                if (error instanceof InviteRaceLostError) {
                  return { ok: false as const, message: error.message };
                }
                throw error;
              },
            ),
          );
          if (!admitted.ok) return refusal(403, admitted.message, "invite-consumed");
          const participant = admitted.participant;

          if (!decision.rejoin) {
            yield* audit(
              principal,
              share,
              "shared_console.join",
              shareAuditMetadata(share, { participantId: participant.id, role: participant.role }),
            );
            yield* relay(() =>
              consoleRelay.markShare(
                share,
                `joined: ${participant.userName ?? participant.userId}`,
              ),
            );
          }
          yield* legacy(() => consoleRelay.refreshShare(share));

          return yield* respond(SharedConsoleJoined)({
            ...(yield* stateOf(share)),
            you: publicParticipant(participant),
            // The affinity hint the guest's WebSocket must carry to reach the
            // replica holding the pty.
            routingKey: share.routingKey,
          });
        }),
      )
      /** Step off the console without ending it. */
      .handle("leave", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const me = yield* legacy(() => getParticipant(share.id, principal.session.userId));
          if (!me) return yield* notFound("You are not on this shared console.");

          yield* legacy(() => detachParticipant(me.id, "left"));
          yield* relay(() =>
            consoleRelay.detachParticipant(
              share,
              me.id,
              "removed",
              "You left this shared console.",
            ),
          );
          yield* audit(
            principal,
            share,
            "shared_console.leave",
            shareAuditMetadata(share, { participantId: me.id, wasDriver: me.role === "driver" }),
          );
          yield* relay(() => consoleRelay.markShare(share, `left: ${me.userName ?? me.userId}`));
          yield* legacy(() => consoleRelay.refreshShare(share));
          return yield* respond(SharedConsoleState)(yield* stateOf(share));
        }),
      )
      /**
       * Move the keyboard: authorised by the current driver (it is theirs to
       * give) or by the owner (it is their box). Two simultaneous grants cannot
       * both win: the partial unique index decides, and the loser gets a 409.
       */
      .handleRaw("handover", ({ params, request }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const body = yield* decodeFirstIssue(
            HandoverSharedConsole,
            yield* readJsonOr(request, null),
          ).pipe(Effect.mapError(() => badRequest("A participantId is required.")));

          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const participants = yield* legacy(() => listParticipants(share.id));
          const target = participants.find((p) => p.id === body.participantId) ?? null;
          const mine = participants.find((p) => p.userId === principal.session.userId) ?? null;
          const currentDriver =
            participants.find((p) => p.role === "driver" && p.status === "joined") ?? null;

          const decision = evaluateHandover({
            share: shareState(share, null),
            actor: caller(principal),
            actorParticipant: mine ? participantState(mine) : null,
            target: target ? participantState(target) : null,
            currentDriver: currentDriver ? participantState(currentDriver) : null,
          });
          if (!decision.ok) return denied(decision);

          const raceLost = yield* legacy(() =>
            setDriver({
              sharedConsoleId: share.id,
              demoteParticipantId: decision.demote,
              promoteParticipantId: decision.promote,
            }).then(
              () => undefined,
              (error: unknown) => {
                if (error instanceof DriverRaceLostError) return error.message;
                throw error;
              },
            ),
          );
          if (raceLost !== undefined) return refusal(409, raceLost, "driver-race-lost");

          yield* audit(
            principal,
            share,
            "shared_console.handover",
            shareAuditMetadata(share, {
              fromParticipantId: decision.demote,
              fromUserId: currentDriver?.userId ?? null,
              toParticipantId: decision.promote,
              toUserId: target?.userId ?? null,
              forced: decision.forced,
            }),
          );
          yield* relay(() =>
            consoleRelay.markShare(
              share,
              `keyboard to ${target?.userName ?? target?.userId ?? "unknown"}${decision.forced ? " (forced by sharer)" : ""}`,
            ),
          );
          yield* legacy(() => consoleRelay.refreshShare(share));
          return yield* respond(SharedConsoleState)(yield* stateOf(share));
        }),
      )
      /**
       * Ask for the keyboard. Grants nothing: it sets a flag the driver and the
       * owner can see, and an observer cannot promote themselves.
       */
      .handle("requestDriver", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const mine = yield* legacy(() => getParticipant(share.id, principal.session.userId));
          const decision = evaluateHandoverRequest({
            share: shareState(share, null),
            actor: caller(principal),
            actorParticipant: mine ? participantState(mine) : null,
          });
          if (!decision.ok) return denied(decision);
          yield* legacy(() => requestDriver(decision.participantId));
          yield* legacy(() => consoleRelay.refreshShare(share));
          return yield* respond(SharedConsoleState)(yield* stateOf(share));
        }),
      )
      /** Mint a replacement invite (the last one is dead). */
      .handleRaw("mintInvite", ({ params, request }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          // An absent, unreadable or `null` body is "no options".
          const raw = yield* readJsonOr(request, {});
          const body = yield* decodeFirstIssue(MintSharedConsoleInvite, raw ?? {}).pipe(
            Effect.mapError(() => badRequest("Invalid body")),
          );
          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const allowed = ownerAction(principal, share);
          if (!allowed.ok) return denied(allowed);
          if (share.status !== "active") {
            return yield* conflict("This shared console is no longer live.");
          }
          const invite = yield* legacy(() =>
            replaceInvite(share.id, body.inviteTtlMinutes ?? DEFAULT_INVITE_TTL_MINUTES),
          );
          yield* audit(
            principal,
            share,
            "shared_console.invite.created",
            shareAuditMetadata(share, { inviteExpiresAt: invite.expiresAt.toISOString() }),
          );
          const refreshed = yield* legacy(() => getSharedConsole(share.id));
          yield* legacy(() => consoleRelay.refreshShare(share));
          // The row was there a moment ago; a concurrent delete is a server error.
          if (!refreshed) return yield* Effect.die(new Error("Shared console vanished"));
          return yield* respond(SharedConsoleCreated)({
            ...(yield* stateOf(refreshed)),
            inviteToken: invite.token,
          });
        }),
      )
      /** Withdraw the outstanding link without ending the share. */
      .handle("withdrawInvite", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const allowed = ownerAction(principal, share);
          if (!allowed.ok) return denied(allowed);
          yield* legacy(() => withdrawInvite(share.id));
          yield* audit(
            principal,
            share,
            "shared_console.invite.withdrawn",
            shareAuditMetadata(share),
          );
          const refreshed = yield* legacy(() => getSharedConsole(share.id));
          yield* legacy(() => consoleRelay.refreshShare(share));
          if (!refreshed) return yield* Effect.die(new Error("Shared console vanished"));
          return yield* respond(SharedConsoleState)(yield* stateOf(refreshed));
        }),
      )
      /**
       * Eject somebody. `removed`, not `left`: an ejected guest cannot resume on
       * their own row and needs a fresh invite. Their socket goes immediately on
       * the replica holding the pty, and within one sweep on the other.
       */
      .handle("removeParticipant", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const allowed = ownerAction(principal, share);
          if (!allowed.ok) return denied(allowed);

          const target = yield* legacy(() => getParticipantById(params.participantId));
          if (!target || target.sharedConsoleId !== share.id) return yield* notFound();
          if (target.userId === share.ownerUserId) {
            return yield* conflict("The sharer cannot be removed; revoke the share instead.");
          }

          yield* legacy(() => detachParticipant(target.id, "removed"));
          yield* relay(() =>
            consoleRelay.detachParticipant(
              share,
              target.id,
              "removed",
              "You were removed from this shared console.",
            ),
          );
          yield* audit(
            principal,
            share,
            "shared_console.participant.removed",
            shareAuditMetadata(share, {
              participantId: target.id,
              removedUserId: target.userId,
              wasDriver: target.role === "driver",
            }),
          );
          yield* relay(() =>
            consoleRelay.markShare(share, `removed: ${target.userName ?? target.userId}`),
          );
          yield* legacy(() => consoleRelay.refreshShare(share));
          return yield* respond(SharedConsoleState)(yield* stateOf(share));
        }),
      )
      /**
       * Revoke the share; the SSH session itself carries on. No
       * `resources:execute` here: ending access must never be gated on still
       * holding the access, or an owner whose role was narrowed mid-incident
       * would be locked out of closing the session they opened.
       */
      .handle("revoke", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const userId = principal.session.userId;
          const share = yield* orgShare(principal.organizationId, params.consoleId);
          const allowed = ownerAction(principal, share);
          if (!allowed.ok) return denied(allowed);

          const closed = yield* legacy(() => closeSharedConsole(share.id, "revoked", userId));
          // Immediate wherever the pty is (through the console relay when that is
          // another replica); the owner's 2s sweep covers a relay that cannot be reached.
          yield* relay(() => consoleRelay.revokeShare(share));
          yield* audit(
            principal,
            share,
            "shared_console.revoked",
            shareAuditMetadata(share, {
              byOwner: share.ownerUserId === userId,
              alreadyClosed: closed === null,
            }),
          );
          return ok;
        }),
      ),
);

export const sharedConsolesDomain = makeDomain(
  "shared-consoles",
  SharedConsolesApi,
  SharedConsolesHandlers,
);
