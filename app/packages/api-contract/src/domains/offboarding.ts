/**
 * Offboarding sweeps: `/api/org/:orgId/offboardings`, the endpoint
 * definitions.
 *
 * One saved checklist per person leaving: everything tied to them across the
 * organization's connected providers and Infrawrench itself, with a way to
 * act on each row. Every route is `team:remove`, the permission that removes
 * a member, because running somebody's offboarding is that job; each action
 * additionally needs the permission its own surface asks for (revoking cloud
 * access `resources:write`, a seat `resources:write`, an API key
 * `apikeys:write`, a rotation `org:settings:write`), and the ones that reach
 * a provider respect the change freeze.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas/checks";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { ChangeFreezeBlocked } from "../http/schemas/change-freeze";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";

const OffboardingStatus = Schema.Literals(["open", "completed", "canceled"]).annotate({
  description:
    "`open` while the checklist is being worked through; `completed` and `canceled` freeze it " +
    "as evidence (a rescan no longer changes it).",
});

const OffboardingSource = Schema.Literals(["manual", "directory"]).annotate({
  description:
    "`manual` when somebody started it; `directory` when an identity directory reported the " +
    "person deprovisioned.",
});

const OffboardingItemKind = Schema.Literals([
  "member",
  "api-key",
  "ssh-key",
  "principal",
  "seat",
  "resource",
  "on-call",
  "on-call-cover",
  "lease",
  "jit-grant",
]).annotate({
  description:
    "What the row is: their Infrawrench membership, API key or SSH key; a cloud principal " +
    "(an IAM user, a membership, a personal key); a paid seat; another synced resource that " +
    "names them or that they own; an on-call rotation or a cover they have not served; a lease " +
    "they set; a just-in-time grant they hold.",
});

const MatchConfidence = Schema.Literals(["exact", "alias", "possible"]).annotate({
  description:
    "`exact`: their email. `alias`: a handle or address listed on the offboarding. " +
    "`possible`: something weaker (the part of the email before the `@`, the same name at " +
    "another domain, their full name) that a person has to confirm before any action is offered.",
});

const MatchState = Schema.Literals(["matched", "unconfirmed", "confirmed", "rejected"]).annotate({
  description:
    "`unconfirmed` possible matches offer no action; `rejected` rows (not them) leave the " +
    "checklist's progress but stay in the export.",
});

const ItemStatus = Schema.Literals(["open", "done", "skipped", "failed", "gone"]).annotate({
  description:
    "`gone` means a later scan no longer found the row: removed outside Infrawrench, or no " +
    "longer reported by the provider.",
});

const OffboardingActionId = Schema.Literals([
  "revoke",
  "remove",
  "remove-seat",
  "remove-member",
  "revoke-api-key",
  "delete-ssh-key",
  "transfer-ownership",
  "reassign-on-call",
  "remove-from-rotation",
  "cancel-cover",
  "cancel-lease",
  "revoke-jit",
]).annotate({
  identifier: "OffboardingActionId",
  description:
    "`revoke` runs the plugin's declared revoke action (`principalRole.revokeActionId`); " +
    "`remove` deletes a principal whose plugin declares `offboardByDelete` (a membership, a " +
    "personal token); `remove-seat` removes a paid seat through the provider; " +
    "`transfer-ownership` and `reassign-on-call` need a `targetUserId`.",
});

const OffboardingProgress = Schema.Struct({
  total: Schema.Int.annotate({ description: "Rows on the checklist, rejected matches excluded." }),
  resolved: Schema.Int.annotate({ description: "Done, skipped or gone." }),
  open: Schema.Int,
  failed: Schema.Int,
  unconfirmed: Schema.Int.annotate({
    description: "Possible matches still waiting for a person to confirm or reject them.",
  }),
}).annotate({ identifier: "OffboardingProgress" });

const offboardingSummaryFields = {
  id: Uuid,
  email: Schema.String.annotate({ description: "Lower-cased.", examples: ["jane@example.com"] }),
  name: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.String).annotate({
    description: "Their Infrawrench user id, when they had an account.",
  }),
  aliases: Schema.Array(Schema.String).annotate({
    description: "Handles and other addresses providers know them by, normalized.",
  }),
  status: OffboardingStatus,
  source: OffboardingSource,
  sourceDetail: Schema.NullOr(Schema.String),
  startedByName: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  lastScannedAt: Schema.NullOr(IsoDateTime),
  scanTruncated: Schema.Boolean.annotate({
    description:
      "The last scan matched more synced resources than one scan reads, so some may be missing.",
  }),
  progress: OffboardingProgress,
};

export const OffboardingSummary = Schema.Struct(offboardingSummaryFields).annotate({
  identifier: "OffboardingSummary",
});

export const OffboardingItem = Schema.Struct({
  id: Uuid,
  kind: OffboardingItemKind,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  pluginId: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String).annotate({
    description: "Provider display name; null for Infrawrench's own records.",
  }),
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  resourceId: Schema.NullOr(Schema.String),
  resourceTypeId: Schema.NullOr(Schema.String),
  confidence: MatchConfidence,
  matchReason: Schema.String.annotate({ description: "Why the sweep thinks this is theirs." }),
  matchState: MatchState,
  actions: Schema.Array(OffboardingActionId).annotate({
    description:
      "What can be done from Infrawrench. Empty: do it in the provider, then mark the row done.",
  }),
  status: ItemStatus,
  resolution: Schema.NullOr(Schema.String).annotate({
    description: 'The action that resolved the row, `"manual"`, or `"gone"`.',
  }),
  lastError: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  resolvedByName: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(IsoDateTime),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
}).annotate({ identifier: "OffboardingItem" });

export const Offboarding = Schema.Struct({
  ...offboardingSummaryFields,
  items: Schema.Array(OffboardingItem),
}).annotate({ identifier: "Offboarding" });

export const OffboardingList = Schema.Struct({
  offboardings: Schema.Array(OffboardingSummary),
}).annotate({ identifier: "OffboardingList" });

export const OffboardingStartResponse = Schema.Struct({
  offboarding: Offboarding,
  created: Schema.Boolean.annotate({
    description: "False when an open offboarding for this person already existed.",
  }),
}).annotate({ identifier: "OffboardingStartResponse" });

const OffboardingCandidate = Schema.Struct({
  key: Schema.String,
  kind: OffboardingItemKind,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  pluginId: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  resourceId: Schema.NullOr(Schema.String),
  resourceTypeId: Schema.NullOr(Schema.String),
  confidence: MatchConfidence,
  matchReason: Schema.String,
  actions: Schema.Array(OffboardingActionId),
}).annotate({ identifier: "OffboardingCandidate" });

export const OffboardingPreview = Schema.Struct({
  email: Schema.String,
  aliases: Schema.Array(Schema.String),
  candidates: Schema.Array(OffboardingCandidate),
  scanTruncated: Schema.Boolean,
}).annotate({ identifier: "OffboardingPreview" });

export const OffboardingMember = Schema.Struct({
  userId: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.String,
}).annotate({ identifier: "OffboardingMember" });

export const OffboardingMembers = Schema.Struct({
  members: Schema.Array(OffboardingMember),
}).annotate({ identifier: "OffboardingMembers" });

export const OffboardingActionResult = Schema.Struct({
  item: OffboardingItem.annotate({
    description:
      "The row after the action. A provider that refused leaves it `failed` with `lastError`; " +
      "the call itself still answers 200, because the checklist recorded the outcome.",
  }),
  message: Schema.NullOr(Schema.String).annotate({
    description: "What the provider said happens next, when it said anything.",
  }),
}).annotate({ identifier: "OffboardingActionResult" });

const Aliases = Schema.Array(Schema.String.check(maxLength(200))).check(maxLength(20));
const Note = Schema.NullOr(Schema.String.check(maxLength(1000)));

export const OffboardingStartInput = Schema.Struct({
  email: Schema.String.check(maxLength(320)).annotate({
    description: "The email address the person signed in with.",
  }),
  aliases: Schema.optionalKey(
    Aliases.annotate({
      description:
        "Handles and other addresses providers know them by (a GitHub login, an old domain).",
    }),
  ),
  note: Schema.optionalKey(Note),
}).annotate({ identifier: "OffboardingStartInput" });

export const OffboardingPreviewInput = Schema.Struct({
  email: Schema.String.check(maxLength(320)),
  aliases: Schema.optionalKey(Aliases),
}).annotate({ identifier: "OffboardingPreviewInput" });

export const OffboardingPatchInput = Schema.Struct({
  aliases: Schema.optionalKey(Aliases),
  note: Schema.optionalKey(Note),
  status: Schema.optionalKey(OffboardingStatus),
}).annotate({ identifier: "OffboardingPatchInput" });

export const OffboardingItemPatchInput = Schema.Struct({
  matchState: Schema.optionalKey(Schema.Literals(["confirmed", "rejected", "unconfirmed"])),
  status: Schema.optionalKey(Schema.Literals(["done", "skipped", "open"])),
  note: Schema.optionalKey(Note),
}).annotate({ identifier: "OffboardingItemPatchInput" });

export const OffboardingActionInput = Schema.Struct({
  action: OffboardingActionId,
  targetUserId: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "The member taking over, for `transfer-ownership` and `reassign-on-call`.",
    }),
  ),
}).annotate({ identifier: "OffboardingActionInput" });

const ItemParams = { orgId: OrgId, id: Uuid, itemId: Uuid } as const;
const IdParams = { orgId: OrgId, id: Uuid } as const;

export class OffboardingGroup extends HttpApiGroup.make("offboarding")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: OffboardingList,
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "List offboardings")
      .annotate(OpenApi.Description, "Every offboarding checklist, newest first, with progress.")
      .annotate(SuccessDescription, "The offboardings"),
    HttpApiEndpoint.post("start", "/", {
      params: OrgParams,
      payload: OffboardingStartInput,
      success: OffboardingStartResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Start an offboarding")
      .annotate(
        OpenApi.Description,
        "Start the checklist for someone leaving, by email plus any aliases, and sweep for " +
          "everything tied to them: their Infrawrench membership, API keys and SSH keys; cloud " +
          "principals and other synced resources that carry their email or an alias in any " +
          "field or that the ownership records name them owner of; paid seats; on-call " +
          "rotations and covers; leases they set; just-in-time grants they hold. The sweep " +
          "reads synced state only and makes no provider calls.\n\n" +
          "Starting again for somebody who already has an open offboarding returns that one, " +
          "with any new aliases merged in.",
      )
      .annotate(SuccessDescription, "The offboarding"),
    HttpApiEndpoint.post("preview", "/preview", {
      params: OrgParams,
      payload: OffboardingPreviewInput,
      success: OffboardingPreview,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Preview an offboarding sweep")
      .annotate(
        OpenApi.Description,
        "What starting an offboarding would find for a person, without saving anything.",
      )
      .annotate(SuccessDescription, "What the sweep found"),
    HttpApiEndpoint.get("members", "/members", {
      params: OrgParams,
      success: OffboardingMembers,
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Members who can take something over")
      .annotate(
        OpenApi.Description,
        "The organization's members, for picking who takes over a resource or an on-call slot.",
      )
      .annotate(SuccessDescription, "The members"),
    HttpApiEndpoint.get("get", "/:id", {
      params: IdParams,
      success: Offboarding,
      error: NotFound,
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Get an offboarding")
      .annotate(SuccessDescription, "The offboarding with its checklist"),
    HttpApiEndpoint.patch("update", "/:id", {
      params: IdParams,
      payload: OffboardingPatchInput,
      success: Offboarding,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Edit an offboarding")
      .annotate(
        OpenApi.Description,
        "Change the aliases (which rescans), the note, or the status: `completed` or `canceled` " +
          "closes the checklist, `open` reopens it.",
      )
      .annotate(SuccessDescription, "The offboarding"),
    HttpApiEndpoint.post("rescan", "/:id/rescan", {
      params: IdParams,
      success: Offboarding,
      error: NotFound,
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Rescan an offboarding")
      .annotate(
        OpenApi.Description,
        "Sweep again. Rows already dealt with keep their outcome; a row no longer found is " +
          "marked `gone`. A closed offboarding is returned unchanged.",
      )
      .annotate(SuccessDescription, "The offboarding")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("export", "/:id/export", {
      params: IdParams,
      query: {
        format: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["csv", "json"]).annotate({ description: 'Defaults to "csv".' }),
          ),
        ),
      },
      success: [Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })), Offboarding],
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Export an offboarding as evidence")
      .annotate(
        OpenApi.Description,
        "The checklist as a download, one row per item, rejected matches included and labelled. " +
          "CSV cells are all quoted and spreadsheet formulas neutralised. Exports are recorded " +
          "in the audit log.",
      )
      .annotate(SuccessDescription, "The offboarding as an attachment"),
    HttpApiEndpoint.patch("updateItem", "/:id/items/:itemId", {
      params: ItemParams,
      payload: OffboardingItemPatchInput,
      success: OffboardingItem,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Confirm a match or mark a row by hand")
      .annotate(
        OpenApi.Description,
        "Confirm or reject a possible match, mark a row done (handled in the provider) or " +
          "skipped (not needed), reopen it, or leave a note.",
      )
      .annotate(SuccessDescription, "The row"),
    HttpApiEndpoint.post("act", "/:id/items/:itemId/action", {
      params: ItemParams,
      payload: OffboardingActionInput,
      success: OffboardingActionResult,
      error: [BadRequest, Forbidden, NotFound, Conflict, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "team:remove")
      .annotate(OpenApi.Summary, "Act on a checklist row")
      .annotate(
        OpenApi.Description,
        "Run one of the row's `actions`. Each needs the permission its own surface asks for on " +
          "top of `team:remove` (403 otherwise), and the ones that reach a provider (`revoke`, " +
          "`remove`, `remove-seat`, `revoke-jit`) are blocked by an active change freeze (423). " +
          "Refused (409) for an unconfirmed or rejected match, a closed offboarding, or an action " +
          "the row does not offer. Every attempt is recorded in the audit log.",
      )
      .annotate(SuccessDescription, "The row after the action"),
  )
  .prefix("/api/org/:orgId/offboardings")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Offboarding") {}

export class OffboardingApi extends withApiDefaults(
  HttpApi.make("offboarding").add(OffboardingGroup),
) {}
