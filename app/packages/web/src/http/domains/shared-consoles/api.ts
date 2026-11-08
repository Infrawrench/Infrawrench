/**
 * Shared consoles: `/api/org/:orgId/shared-consoles`, the endpoint
 * definitions. Sharing a live cloud SSH session with colleagues, joining one,
 * moving the keyboard, and taking access away again. The terminal stream
 * itself rides the WebSocket `server.ts` upgrades (`console:attach`).
 *
 * Sharing creates no capability: everyone on a console holds
 * `resources:execute` themselves, which is the gate on the routes that grant
 * or use access. The routes that *take access away* (leave, revoke, eject,
 * withdraw an invite) carry no permission on purpose and are gated in the
 * handler on being the sharer or holding `org:settings:write`.
 *
 * Bodies are judged as the routes' zod validators judged them, with their own
 * sentences, so the writes are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";

const ParticipantRole = Schema.Literals(["observer", "driver"]).annotate({
  description:
    "`driver` holds the keyboard; `observer` sees the terminal and cannot type into it. " +
    "Exactly one participant per console is a driver at any moment, enforced by a partial " +
    "unique index rather than by the application; two simultaneous handovers cannot both win.",
});

const ParticipantStatus = Schema.Literals(["joined", "left", "removed"]).annotate({
  description:
    "`left` walked away and may resume on the same row without a new invite; `removed` was " +
    "ejected or lost the permission mid-session and needs a fresh one.",
});

const SharedConsoleStatus = Schema.Literals(["active", "revoked", "ended"]).annotate({
  description:
    "`revoked`: somebody ended the share; `ended`: the underlying SSH session closed. " +
    "Either way the fan-out stops and attached guests are disconnected.",
});

const SharedConsoleParticipant = Schema.Struct({
  id: Uuid,
  userId: Schema.String,
  userName: Schema.NullOr(Schema.String).annotate({
    description: "Display-name snapshot taken when they joined.",
  }),
  role: ParticipantRole,
  status: ParticipantStatus,
  driverRequestedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "Set when this participant has asked for the keyboard and nobody has answered yet. " +
      "Asking grants nothing; only the current driver or the sharer can move it.",
  }),
  joinedAt: IsoDateTime,
}).annotate({ identifier: "SharedConsoleParticipant" });

const sharedConsoleFields = {
  id: Uuid,
  routingKey: Schema.String.annotate({
    description:
      "Load-balancer affinity hint. A guest's WebSocket must carry it as `?sid=` so the " +
      "upgrade lands on the replica holding the pty. Not a secret and not authorisation.",
  }),
  ownerUserId: Schema.NullOr(Schema.String),
  ownerName: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Uuid),
  resourceId: Schema.NullOr(Schema.String),
  host: Schema.String.annotate({
    description: "Final hop, as the proxy dialled it; never as a client asserted it.",
  }),
  port: Schema.Int,
  username: Schema.String,
  allowHandover: Schema.Boolean.annotate({
    description:
      "False makes the share strictly read-only: nobody but the sharer can ever type. This " +
      "is the one hard safety property the feature offers, as opposed to inferring intent " +
      "from command text.",
  }),
  status: SharedConsoleStatus,
  inviteTokenPrefix: Schema.NullOr(Schema.String),
  inviteExpiresAt: Schema.NullOr(IsoDateTime),
  inviteConsumedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "Set once an invite admitted somebody new. The link stops working for anyone else at " +
      "that moment; the sharer mints a replacement for the next guest.",
  }),
  recordingId: Schema.NullOr(Uuid).annotate({
    description:
      "The session recording this console is being taped into, when the org records. " +
      "Participants are attributed in that recording's own metadata and as asciicast " +
      "markers on its timeline.",
  }),
  ptyCols: Schema.Int,
  ptyRows: Schema.Int.annotate({
    description:
      "The pty's geometry, which is the **driver's** geometry. One pty has one size, so " +
      "everyone else letterboxes rather than reflowing.",
  }),
  createdAt: IsoDateTime,
};

const SharedConsole = Schema.Struct(sharedConsoleFields).annotate({
  identifier: "SharedConsole",
});

const Participants = Schema.Array(SharedConsoleParticipant);

export const SharedConsoleState = Schema.Struct({
  share: SharedConsole,
  participants: Participants,
}).annotate({ identifier: "SharedConsoleState" });

export const SharedConsoleSummary = Schema.Struct({
  ...sharedConsoleFields,
  participants: Participants,
}).annotate({ identifier: "SharedConsoleSummary" });

export const SharedConsoleCreated = Schema.Struct({
  share: SharedConsole,
  participants: Participants,
  inviteToken: Schema.String.annotate({
    description:
      "The invite, returned exactly once. Only its sha256 is stored, so it cannot be shown " +
      "again: mint a replacement instead.",
  }),
}).annotate({ identifier: "SharedConsoleCreated" });

export const SharedConsoleJoined = Schema.Struct({
  share: SharedConsole,
  participants: Participants,
  you: SharedConsoleParticipant,
  routingKey: Schema.String,
}).annotate({ identifier: "SharedConsoleJoined" });

export const SharedConsoleInvitePreview = Schema.Struct({
  share: SharedConsole,
  joinable: Schema.Boolean,
  rejoin: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "You are already on this console and would resume." }),
  ),
  error: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SharedConsoleInvitePreview" });

/** zod's `z.string().uuid()`: the shape only, refused with zod's sentence. */
const CheckedUuid = Schema.String.annotate({
  format: "uuid",
  examples: ["00000000-0000-0000-0000-000000000000"],
}).check(Schema.isGUID({ message: "Invalid uuid", toJsonSchema: () => ({}) }));

/** `MIN_INVITE_TTL_MINUTES` and `MAX_INVITE_TTL_MINUTES` of `shared-console/invites`. */
const InviteTtlMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 }));

export const CreateSharedConsole = Schema.Struct({
  liveConsoleId: CheckedUuid.annotate({
    description:
      "The pty to share, as the terminal's WebSocket reported it in its `ssh:connected` frame. " +
      "Everything else about the session (host, account, recording) is read from the " +
      "proxy's own registration rather than from this body.",
  }),
  routingKey: Schema.String.check(minLength(8), maxLength(128)),
  allowHandover: Schema.optionalKey(Schema.Boolean.annotate({ description: "Defaults to true." })),
  inviteTtlMinutes: Schema.optionalKey(
    InviteTtlMinutes.annotate({ description: "Defaults to 15." }),
  ),
}).annotate({ identifier: "CreateSharedConsole" });

export const JoinSharedConsole = Schema.Struct({
  token: Schema.String.check(minLength(1), maxLength(200)),
});

export const HandoverSharedConsole = Schema.Struct({ participantId: CheckedUuid });

export const MintSharedConsoleInvite = Schema.Struct({
  inviteTtlMinutes: Schema.optionalKey(InviteTtlMinutes),
});

const ConsoleParams = { orgId: OrgId, consoleId: Uuid } as const;

export class SharedConsolesGroup extends HttpApiGroup.make("sharedConsoles")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(SharedConsoleSummary),
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "List sessions currently shared")
      .annotate(
        OpenApi.Description,
        "Live shared SSH sessions in this organization, with who is on each. Only cloud SSH can " +
          "be shared: those sessions are already proxied by the server, so fanning the pty out to " +
          "a second socket is a consumer of a stream it holds. A desktop session dialling a host " +
          "directly never reaches the server and cannot be shared.",
      )
      .annotate(SuccessDescription, "Live shared consoles"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CreateSharedConsole,
      success: SharedConsoleCreated,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Share a live SSH session")
      .annotate(
        OpenApi.Description,
        "Opens a share on a session you already have running and mints its first invite. You " +
          "become the driver.\n\n" +
          "Returns 409 `console_not_here` when the pty is held by a different server replica than " +
          "the one answering this call; reopen the terminal and share again. Writing the share " +
          "anyway would produce a link that authorises correctly and then finds nothing to attach " +
          "to.\n\n" +
          "Requires `resources:execute`: the same permission as opening the terminal. Closed to " +
          "API keys: sharing a shell is an act a person performs.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "The share, its participants, and the one-time invite token"),
    HttpApiEndpoint.get("invitePreview", "/invites/:token", {
      params: { orgId: OrgId, token: Schema.String },
      success: SharedConsoleInvitePreview,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Preview what an invite link points at")
      .annotate(
        OpenApi.Description,
        "What the join screen shows before anyone commits: which host, whose session, and " +
          "whether you may join it. Reachable with a valid token by a signed-in member who " +
          "already holds `resources:execute`: the token says *which* session, never *whether*. " +
          "Returns nothing from the session itself.",
      )
      .annotate(SuccessDescription, "The share and whether the caller may join it"),
    HttpApiEndpoint.get("get", "/:consoleId", {
      params: ConsoleParams,
      success: SharedConsoleState,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Get one shared console")
      .annotate(
        OpenApi.Description,
        "Visible to participants and to anyone who could revoke it (the sharer, or a holder of " +
          "`org:settings:write`). Others get 404: that a named colleague has a root shell open " +
          "on a named production host right now is operational information.",
      )
      .annotate(SuccessDescription, "The share and its participants"),
    HttpApiEndpoint.post("join", "/:consoleId/join", {
      params: ConsoleParams,
      payload: Schema.Struct({ token: Schema.String }),
      success: SharedConsoleJoined,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Redeem an invite and join")
      .annotate(
        OpenApi.Description,
        "Admission needs live org membership **and** `resources:execute`: the invite is a " +
          "locator, never a capability, so a leaked link admits nobody who could not have opened " +
          "the shell themselves.\n\n" +
          "The invite is consumed by the first person it admits. Somebody already on the console " +
          "resumes their own row without a token, so a reload costs them nothing and obliges the " +
          "sharer to mint nothing. New joiners always start as observers whatever the link said.\n\n" +
          "Audit-logged as `shared_console.join`, and written onto the recording's timeline as an " +
          "asciicast marker.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "You are on the console"),
    HttpApiEndpoint.post("leave", "/:consoleId/leave", {
      params: ConsoleParams,
      success: SharedConsoleState,
      error: NotFound,
    })
      .annotate(OpenApi.Summary, "Leave a shared console")
      .annotate(
        OpenApi.Description,
        "Steps you off without ending the session. Your row survives, so the same invite is not " +
          "needed again. Deliberately does not require `resources:execute`: giving access up must " +
          "never be gated on still holding it.",
      )
      .annotate(SuccessDescription, "Updated state"),
    HttpApiEndpoint.post("handover", "/:consoleId/handover", {
      params: ConsoleParams,
      payload: Schema.Struct({ participantId: Uuid }),
      success: SharedConsoleState,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Move the keyboard to another participant")
      .annotate(
        OpenApi.Description,
        "Authorised by the **current driver** (the keyboard is theirs to give) or by the " +
          "**sharer** (it is their box, and asking permission from somebody who has stopped " +
          "responding is not a control). An observer cannot promote themselves; that is " +
          "`/request-driver`.\n\n" +
          "Two simultaneous grants cannot both win: the database's partial unique index decides " +
          "the order, and the loser gets 409 `driver-race-lost`.\n\n" +
          "The pty resizes to the new driver's viewport; everyone else letterboxes.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "Updated state"),
    HttpApiEndpoint.post("requestDriver", "/:consoleId/request-driver", {
      params: ConsoleParams,
      success: SharedConsoleState,
      error: [Forbidden, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:execute")
      .annotate(OpenApi.Summary, "Ask for the keyboard")
      .annotate(
        OpenApi.Description,
        "Raises a flag the driver and the sharer can see. Grants nothing on its own; that is " +
          "the point.",
      )
      .annotate(SuccessDescription, "Updated state"),
    HttpApiEndpoint.post("mintInvite", "/:consoleId/invites", {
      params: ConsoleParams,
      payload: MintSharedConsoleInvite,
      success: SharedConsoleCreated,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(OpenApi.Summary, "Mint a replacement invite")
      .annotate(
        OpenApi.Description,
        "An invite is spent by the first person it admits, so inviting a second guest means " +
          "minting a second link. Replaces any outstanding one. Sharer or `org:settings:write`.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "The new invite"),
    HttpApiEndpoint.delete("withdrawInvite", "/:consoleId/invites", {
      params: ConsoleParams,
      success: SharedConsoleState,
      error: [Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Withdraw the outstanding invite")
      .annotate(
        OpenApi.Description,
        "Kills the link without touching the session or anyone already on it.",
      )
      .annotate(SuccessDescription, "Updated state"),
    HttpApiEndpoint.delete("removeParticipant", "/:consoleId/participants/:participantId", {
      params: { ...ConsoleParams, participantId: Uuid },
      success: SharedConsoleState,
      error: [Forbidden, NotFound, Conflict],
    })
      .annotate(OpenApi.Summary, "Remove somebody from a shared console")
      .annotate(
        OpenApi.Description,
        "Their socket is closed immediately on the replica holding the pty, and within one " +
          "two-second sweep on any other. They are marked `removed` rather than `left`, so they " +
          "cannot resume without a fresh invite. The sharer cannot be removed, revoke the share.",
      )
      .annotate(SuccessDescription, "Updated state"),
    HttpApiEndpoint.delete("revoke", "/:consoleId", {
      params: ConsoleParams,
      success: Ok,
      error: [Forbidden, NotFound],
    })
      .annotate(OpenApi.Summary, "Revoke a share")
      .annotate(
        OpenApi.Description,
        "Disconnects every guest and stops the fan-out. The sharer's own SSH session carries on " +
          ": revoking a share is not killing a terminal.\n\n" +
          "The sharer or a holder of `org:settings:write`. Deliberately does **not** require " +
          "`resources:execute`: ending access must never be gated on still holding the access, or " +
          "an owner whose role was narrowed mid-incident could not close the session they opened.",
      )
      .annotate(SuccessDescription, "Revoked"),
  )
  .prefix("/api/org/:orgId/shared-consoles")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Shared consoles") {}

export class SharedConsolesApi extends withApiDefaults(
  HttpApi.make("shared-consoles").add(SharedConsolesGroup),
) {}
