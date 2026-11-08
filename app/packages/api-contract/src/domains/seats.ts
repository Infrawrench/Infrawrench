/**
 * SaaS seats: `/api/org/:orgId/seats`, the endpoint definitions.
 *
 * Reads are `costs:read`: the page is seat prices and savings, the
 * realized-savings stance, and it names people by email, which is not a
 * resource listing. Removing a seat changes a provider account, so it is
 * `resources:write` behind the change freeze. The threshold is `costs:write`,
 * the realized-savings settings permission, since it decides what the org's
 * savings figures say.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { ChangeFreezeBlocked } from "../http/schemas/change-freeze";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";
import { FindingRemediation } from "../http/schemas/remediation";

const SeatCategory = Schema.Literals([
  "ai-coding",
  "ai-assistant",
  "source-control",
  "identity",
  "other",
]).annotate({
  description:
    "What the seat is for. Two seats one person holds in the same category on different " +
    "products are a duplicate finding; `other` never is.",
});

const ActivityBasis = Schema.Literals([
  "last-activity",
  "last-login",
  "usage-window",
  "none",
]).annotate({
  description:
    "How the provider evidences use: `last-activity` (last use of the product), `last-login` " +
    "(last sign-in), `usage-window` (per-day usage over `activityWindowDays`), or `none` (no " +
    "evidence; never flagged inactive).",
});

const PriceSource = Schema.Literals(["billing", "catalog", "configured", "list-price"]).annotate({
  description:
    "`billing`/`catalog`: read from the provider. `configured`: the price set on the account. " +
    "`list-price`: the provider's published list price, an estimate.",
});

const SeatStatus = Schema.Literals([
  "active",
  "inactive",
  "new",
  "unknown",
  "pending-removal",
]).annotate({
  description:
    "`inactive`: the evidence covers the threshold and shows no use. `new`: assigned inside " +
    "the threshold and not used yet. `unknown`: the evidence cannot cover the threshold. " +
    "`pending-removal`: already being removed at the provider.",
});

const SeatPrice = Schema.Struct({
  monthly: Schema.Finite,
  currency: Schema.String.annotate({ examples: ["USD"] }),
  source: PriceSource,
  note: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SeatPrice" });

const Seat = Schema.Struct({
  id: Uuid.annotate({ description: "Infrawrench seat id; the handle for removal." }),
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["GitHub"] }),
  memberId: Schema.String.annotate({ description: "Provider-native member id." }),
  seatKey: Schema.String.annotate({
    description: "Empty unless one member holds several seats on the account.",
  }),
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  login: Schema.NullOr(Schema.String),
  product: Schema.String.annotate({ examples: ["GitHub Copilot"] }),
  category: SeatCategory,
  seatType: Schema.String.annotate({ examples: ["Copilot Business"] }),
  monthlyPrice: Schema.NullOr(Schema.Finite).annotate({
    description: "Per month; null when unpriced.",
  }),
  currency: Schema.NullOr(Schema.String),
  priceSource: Schema.NullOr(PriceSource),
  priceNote: Schema.NullOr(Schema.String),
  activityBasis: ActivityBasis,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  activityWindowDays: Schema.NullOr(Schema.Int),
  activitySource: Schema.String.annotate({
    description: "Plain-English description of the evidence.",
  }),
  assignedAt: Schema.NullOr(IsoDateTime),
  pendingRemovalOn: Schema.NullOr(IsoDateTime),
  removable: Schema.Boolean.annotate({ description: "Whether the in-app Remove can remove it." }),
  removalNote: Schema.NullOr(Schema.String),
  downgrade: Schema.NullOr(
    Schema.Struct({ seatType: Schema.String, price: SeatPrice, reason: Schema.String }),
  ),
  context: Schema.Record(Schema.String, Schema.String),
  resource: Schema.NullOr(
    Schema.Struct({ resourceTypeId: Schema.String, externalId: Schema.String }),
  ),
  lastSeenAt: IsoDateTime,
  status: SeatStatus,
  daysInactive: Schema.NullOr(Schema.Int),
  neverActive: Schema.Boolean,
}).annotate({ identifier: "Seat" });

const SeatFinding = Schema.Struct({
  kind: Schema.Literals(["inactive", "duplicate", "downgrade"]),
  seatId: Uuid,
  monthlySaving: Schema.NullOr(Schema.Finite),
  currency: Schema.NullOr(Schema.String),
  duplicate: Schema.optionalKey(
    Schema.Struct({
      keptSeatId: Uuid,
      keptProduct: Schema.String,
      keptAccountName: Schema.String,
      keptLastActiveAt: Schema.NullOr(IsoDateTime),
    }).annotate({ description: "For a duplicate: the seat kept (the one used most recently)." }),
  ),
  targetSeatType: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  remediation: Schema.optionalKey(FindingRemediation),
}).annotate({ identifier: "SeatFinding" });

const SeatTotal = Schema.Struct({ currency: Schema.String, monthly: Schema.Finite }).annotate({
  identifier: "SeatTotal",
});

export const SeatListResponse = Schema.Struct({
  inactiveDays: Schema.Int,
  seats: Schema.Array(Seat),
  findings: Schema.Array(SeatFinding).annotate({
    description: "Largest saving first; at most one per seat.",
  }),
  savingsMonthly: Schema.Array(SeatTotal),
  spendMonthly: Schema.Array(SeatTotal),
  counts: Schema.Struct({
    seats: Schema.Int,
    inactive: Schema.Int,
    duplicate: Schema.Int,
    downgrade: Schema.Int,
    unknownActivity: Schema.Int,
    unpriced: Schema.Int,
  }),
  accounts: Schema.Array(
    Schema.Struct({
      accountId: Uuid,
      accountName: Schema.String,
      pluginId: PluginId,
      pluginName: Schema.String,
      seatCount: Schema.Int,
      lastPolledAt: Schema.NullOr(IsoDateTime),
      lastError: Schema.NullOr(Schema.String),
    }),
  ),
}).annotate({ identifier: "SeatListResponse" });

/** Documented; server-core checks the bound and rejects rather than clamps. */
export const SeatSettings = Schema.Struct({
  inactiveDays: Schema.Int.check(Schema.isBetween({ minimum: 7, maximum: 365 })).annotate({
    description: "Days without use before a seat is flagged. Default 30.",
  }),
}).annotate({ identifier: "SeatSettings" });

export const SeatRefreshResponse = Schema.Struct({ queued: Schema.Int });

export const SeatRemovalResponse = Schema.Struct({
  effective: Schema.Literals(["immediate", "end-of-cycle"]),
  message: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SeatRemovalResponse" });

export class SeatsGroup extends HttpApiGroup.make("seats")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: SeatListResponse,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List paid SaaS seats and seat savings findings")
      .annotate(
        OpenApi.Description,
        "Every paid seat the organization's connected accounts report (Copilot, Cursor, GitLab, " +
          "Okta and others), collected daily, with three findings: inactive for the organization's " +
          "threshold, the same person (by email) paying for two tools in one category, and a " +
          "cheaper tier the member's usage fits. Each finding carries remediation commands.",
      )
      .annotate(SuccessDescription, "Seats and findings"),
    HttpApiEndpoint.post("refresh", "/refresh", {
      params: OrgParams,
      success: SeatRefreshResponse,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Re-collect seats now")
      .annotate(
        OpenApi.Description,
        "Makes every seat-capable account due; the poller collects within minutes.",
      )
      .annotate(SuccessDescription, "Accounts queued"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: SeatSettings,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get the seat settings")
      .annotate(SuccessDescription, "Seat settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: SeatSettings,
      success: SeatSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update the seat settings")
      .annotate(
        OpenApi.Description,
        "`inactiveDays` must be a whole number from 7 to 365; it is rejected, not clamped.",
      )
      .annotate(SuccessDescription, "The saved settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("remove", "/:seatId/remove", {
      params: { orgId: OrgId, seatId: Uuid },
      success: SeatRemovalResponse,
      error: [BadRequest, NotFound, Conflict, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Remove a flagged seat")
      .annotate(
        OpenApi.Description,
        "Removes a seat currently flagged inactive or duplicated through the provider's API and " +
          "records the realized saving. Refused (409) for a seat that is not a finding. Blocked " +
          "by an active change freeze (423).",
      )
      .annotate(SuccessDescription, "Removed"),
  )
  .prefix("/api/org/:orgId/seats")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Seats") {}

export class SeatsApi extends withApiDefaults(HttpApi.make("seats").add(SeatsGroup)) {}
