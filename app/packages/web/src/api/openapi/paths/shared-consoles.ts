import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime, Ok } from "../common";
import type { BuildContext } from "../context";

const ParticipantRole = z.enum(["observer", "driver"]).openapi({
  description:
    "`driver` holds the keyboard; `observer` sees the terminal and cannot type into it. " +
    "Exactly one participant per console is a driver at any moment, enforced by a partial " +
    "unique index rather than by the application — two simultaneous handovers cannot both win.",
});

const ParticipantStatus = z.enum(["joined", "left", "removed"]).openapi({
  description:
    "`left` walked away and may resume on the same row without a new invite; `removed` was " +
    "ejected or lost the permission mid-session and needs a fresh one.",
});

const SharedConsoleStatus = z.enum(["active", "revoked", "ended"]).openapi({
  description:
    "`revoked` — somebody ended the share; `ended` — the underlying SSH session closed. " +
    "Either way the fan-out stops and attached guests are disconnected.",
});

export function registerSharedConsolePaths(ctx: BuildContext) {
  const { registry } = ctx;

  const SharedConsoleParticipant = strict({
    id: Uuid,
    userId: z.string(),
    userName: z.string().nullable().describe("Display-name snapshot taken when they joined."),
    role: ParticipantRole,
    status: ParticipantStatus,
    driverRequestedAt: IsoDateTime.nullable().describe(
      "Set when this participant has asked for the keyboard and nobody has answered yet. " +
        "Asking grants nothing — only the current driver or the sharer can move it.",
    ),
    joinedAt: IsoDateTime,
  }).openapi("SharedConsoleParticipant");

  const SharedConsole = strict({
    id: Uuid,
    routingKey: z
      .string()
      .describe(
        "Load-balancer affinity hint. A guest's WebSocket must carry it as `?sid=` so the " +
          "upgrade lands on the replica holding the pty. Not a secret and not authorisation.",
      ),
    ownerUserId: z.string().nullable(),
    ownerName: z.string().nullable(),
    accountId: Uuid.nullable(),
    resourceId: z.string().nullable(),
    host: z
      .string()
      .describe("Final hop, as the proxy dialled it — never as a client asserted it."),
    port: z.number().int(),
    username: z.string(),
    allowHandover: z
      .boolean()
      .describe(
        "False makes the share strictly read-only: nobody but the sharer can ever type. This " +
          "is the one hard safety property the feature offers, as opposed to inferring intent " +
          "from command text.",
      ),
    status: SharedConsoleStatus,
    inviteTokenPrefix: z.string().nullable(),
    inviteExpiresAt: IsoDateTime.nullable(),
    inviteConsumedAt: IsoDateTime.nullable().describe(
      "Set once an invite admitted somebody new. The link stops working for anyone else at " +
        "that moment; the sharer mints a replacement for the next guest.",
    ),
    recordingId: Uuid.nullable().describe(
      "The session recording this console is being taped into, when the org records. " +
        "Participants are attributed in that recording's own metadata and as asciicast " +
        "markers on its timeline.",
    ),
    ptyCols: z.number().int(),
    ptyRows: z
      .number()
      .int()
      .describe(
        "The pty's geometry, which is the **driver's** geometry. One pty has one size, so " +
          "everyone else letterboxes rather than reflowing.",
      ),
    createdAt: IsoDateTime,
  }).openapi("SharedConsole");

  const SharedConsoleWithParticipants = strict({
    share: SharedConsole,
    participants: z.array(SharedConsoleParticipant),
  }).openapi("SharedConsoleState");

  const SharedConsoleSummary = SharedConsole.extend({
    participants: z.array(SharedConsoleParticipant),
  }).openapi("SharedConsoleSummary");

  const SharedConsoleCreated = strict({
    share: SharedConsole,
    participants: z.array(SharedConsoleParticipant),
    inviteToken: z
      .string()
      .describe(
        "The invite, returned exactly once. Only its sha256 is stored, so it cannot be shown " +
          "again — mint a replacement instead.",
      ),
  }).openapi("SharedConsoleCreated");

  const SharedConsoleJoined = strict({
    share: SharedConsole,
    participants: z.array(SharedConsoleParticipant),
    you: SharedConsoleParticipant,
    routingKey: z.string(),
  }).openapi("SharedConsoleJoined");

  const SharedConsoleInvitePreview = strict({
    share: SharedConsole,
    joinable: z.boolean(),
    rejoin: z.boolean().optional().describe("You are already on this console and would resume."),
    error: z.string().optional(),
    code: z.string().optional(),
  }).openapi("SharedConsoleInvitePreview");

  const CreateSharedConsole = strict({
    liveConsoleId: Uuid.describe(
      "The pty to share, as the terminal's WebSocket reported it in its `ssh:connected` frame. " +
        "Everything else about the session — host, account, recording — is read from the " +
        "proxy's own registration rather than from this body.",
    ),
    routingKey: z.string().min(8).max(128),
    allowHandover: z.boolean().optional().describe("Defaults to true."),
    inviteTtlMinutes: z.number().int().min(1).max(120).optional().describe("Defaults to 15."),
  }).openapi("CreateSharedConsole");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/shared-consoles",
    tags: ["Shared consoles"],
    summary: "List sessions currently shared",
    description:
      "Live shared SSH sessions in this organization, with who is on each. Only cloud SSH can " +
      "be shared: those sessions are already proxied by the server, so fanning the pty out to " +
      "a second socket is a consumer of a stream it holds. A desktop session dialling a host " +
      "directly never reaches the server and cannot be shared.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Live shared consoles",
        content: { "application/json": { schema: z.array(SharedConsoleSummary) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/shared-consoles",
    tags: ["Shared consoles"],
    summary: "Share a live SSH session",
    description:
      "Opens a share on a session you already have running and mints its first invite. You " +
      "become the driver.\n\n" +
      "Returns 409 `console_not_here` when the pty is held by a different server replica than " +
      "the one answering this call — reopen the terminal and share again. Writing the share " +
      "anyway would produce a link that authorises correctly and then finds nothing to attach " +
      "to.\n\n" +
      "Requires `resources:execute` — the same permission as opening the terminal. Closed to " +
      "API keys: sharing a shell is an act a person performs.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateSharedConsole } } },
    },
    responses: {
      200: {
        description: "The share, its participants, and the one-time invite token",
        content: { "application/json": { schema: SharedConsoleCreated } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/shared-consoles/invites/{token}",
    tags: ["Shared consoles"],
    summary: "Preview what an invite link points at",
    description:
      "What the join screen shows before anyone commits: which host, whose session, and " +
      "whether you may join it. Reachable with a valid token by a signed-in member who " +
      "already holds `resources:execute` — the token says *which* session, never *whether*. " +
      "Returns nothing from the session itself.",
    request: { params: OrgIdParam.extend({ token: z.string() }) },
    responses: {
      200: {
        description: "The share and whether the caller may join it",
        content: { "application/json": { schema: SharedConsoleInvitePreview } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}",
    tags: ["Shared consoles"],
    summary: "Get one shared console",
    description:
      "Visible to participants and to anyone who could revoke it (the sharer, or a holder of " +
      "`org:settings:write`). Others get 404 — that a named colleague has a root shell open " +
      "on a named production host right now is operational information.",
    request: { params: OrgIdParam.extend({ consoleId: Uuid }) },
    responses: {
      200: {
        description: "The share and its participants",
        content: { "application/json": { schema: SharedConsoleWithParticipants } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}/join",
    tags: ["Shared consoles"],
    summary: "Redeem an invite and join",
    description:
      "Admission needs live org membership **and** `resources:execute` — the invite is a " +
      "locator, never a capability, so a leaked link admits nobody who could not have opened " +
      "the shell themselves.\n\n" +
      "The invite is consumed by the first person it admits. Somebody already on the console " +
      "resumes their own row without a token, so a reload costs them nothing and obliges the " +
      "sharer to mint nothing. New joiners always start as observers whatever the link said.\n\n" +
      "Audit-logged as `shared_console.join`, and written onto the recording's timeline as an " +
      "asciicast marker.",
    request: {
      params: OrgIdParam.extend({ consoleId: Uuid }),
      body: {
        content: { "application/json": { schema: strict({ token: z.string() }) } },
      },
    },
    responses: {
      200: {
        description: "You are on the console",
        content: { "application/json": { schema: SharedConsoleJoined } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}/leave",
    tags: ["Shared consoles"],
    summary: "Leave a shared console",
    description:
      "Steps you off without ending the session. Your row survives, so the same invite is not " +
      "needed again. Deliberately does not require `resources:execute`: giving access up must " +
      "never be gated on still holding it.",
    request: { params: OrgIdParam.extend({ consoleId: Uuid }) },
    responses: {
      200: {
        description: "Updated state",
        content: { "application/json": { schema: SharedConsoleWithParticipants } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}/handover",
    tags: ["Shared consoles"],
    summary: "Move the keyboard to another participant",
    description:
      "Authorised by the **current driver** (the keyboard is theirs to give) or by the " +
      "**sharer** (it is their box, and asking permission from somebody who has stopped " +
      "responding is not a control). An observer cannot promote themselves — that is " +
      "`/request-driver`.\n\n" +
      "Two simultaneous grants cannot both win: the database's partial unique index decides " +
      "the order, and the loser gets 409 `driver-race-lost`.\n\n" +
      "The pty resizes to the new driver's viewport; everyone else letterboxes.",
    request: {
      params: OrgIdParam.extend({ consoleId: Uuid }),
      body: { content: { "application/json": { schema: strict({ participantId: Uuid }) } } },
    },
    responses: {
      200: {
        description: "Updated state",
        content: { "application/json": { schema: SharedConsoleWithParticipants } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}/request-driver",
    tags: ["Shared consoles"],
    summary: "Ask for the keyboard",
    description:
      "Raises a flag the driver and the sharer can see. Grants nothing on its own — that is " +
      "the point.",
    request: { params: OrgIdParam.extend({ consoleId: Uuid }) },
    responses: {
      200: {
        description: "Updated state",
        content: { "application/json": { schema: SharedConsoleWithParticipants } },
      },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}/invites",
    tags: ["Shared consoles"],
    summary: "Mint a replacement invite",
    description:
      "An invite is spent by the first person it admits, so inviting a second guest means " +
      "minting a second link. Replaces any outstanding one. Sharer or `org:settings:write`.",
    request: {
      params: OrgIdParam.extend({ consoleId: Uuid }),
      body: {
        content: {
          "application/json": {
            schema: strict({ inviteTtlMinutes: z.number().int().min(1).max(120).optional() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The new invite",
        content: { "application/json": { schema: SharedConsoleCreated } },
      },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}/invites",
    tags: ["Shared consoles"],
    summary: "Withdraw the outstanding invite",
    description: "Kills the link without touching the session or anyone already on it.",
    request: { params: OrgIdParam.extend({ consoleId: Uuid }) },
    responses: {
      200: {
        description: "Updated state",
        content: { "application/json": { schema: SharedConsoleWithParticipants } },
      },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}/participants/{participantId}",
    tags: ["Shared consoles"],
    summary: "Remove somebody from a shared console",
    description:
      "Their socket is closed immediately on the replica holding the pty, and within one " +
      "two-second sweep on any other. They are marked `removed` rather than `left`, so they " +
      "cannot resume without a fresh invite. The sharer cannot be removed — revoke the share.",
    request: { params: OrgIdParam.extend({ consoleId: Uuid, participantId: Uuid }) },
    responses: {
      200: {
        description: "Updated state",
        content: { "application/json": { schema: SharedConsoleWithParticipants } },
      },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/shared-consoles/{consoleId}",
    tags: ["Shared consoles"],
    summary: "Revoke a share",
    description:
      "Disconnects every guest and stops the fan-out. The sharer's own SSH session carries on " +
      "— revoking a share is not killing a terminal.\n\n" +
      "The sharer or a holder of `org:settings:write`. Deliberately does **not** require " +
      "`resources:execute`: ending access must never be gated on still holding the access, or " +
      "an owner whose role was narrowed mid-incident could not close the session they opened.",
    request: { params: OrgIdParam.extend({ consoleId: Uuid }) },
    responses: {
      200: { description: "Revoked", content: { "application/json": { schema: Ok } } },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });
}
