import { z } from "../zod";
import {
  strict,
  ErrorResponses,
  OrgIdParam,
  Uuid,
  IsoDateTime,
  FindingRemediation,
} from "../common";
import type { BuildContext } from "../context";

const SeatCategory = z
  .enum(["ai-coding", "ai-assistant", "source-control", "identity", "other"])
  .openapi({
    description:
      "What the seat is for. Two seats one person holds in the same category on different " +
      "products are a duplicate finding; `other` never is.",
  });

const ActivityBasis = z.enum(["last-activity", "last-login", "usage-window", "none"]).openapi({
  description:
    "How the provider evidences use: `last-activity` (last use of the product), `last-login` " +
    "(last sign-in), `usage-window` (per-day usage over `activityWindowDays`), or `none` (no " +
    "evidence; never flagged inactive).",
});

const PriceSource = z.enum(["billing", "catalog", "configured", "list-price"]).openapi({
  description:
    "`billing`/`catalog`: read from the provider. `configured`: the price set on the account. " +
    "`list-price`: the provider's published list price, an estimate.",
});

const SeatStatus = z.enum(["active", "inactive", "new", "unknown", "pending-removal"]).openapi({
  description:
    "`inactive`: the evidence covers the threshold and shows no use. `new`: assigned inside " +
    "the threshold and not used yet. `unknown`: the evidence cannot cover the threshold. " +
    "`pending-removal`: already being removed at the provider.",
});

export function registerSeatPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const Price = strict({
    monthly: z.number(),
    currency: z.string().openapi({ example: "USD" }),
    source: PriceSource,
    note: z.string().optional(),
  }).openapi("SeatPrice");

  const Seat = strict({
    id: Uuid.describe("Infrawrench seat id; the handle for removal."),
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "GitHub" }),
    memberId: z.string().describe("Provider-native member id."),
    seatKey: z.string().describe("Empty unless one member holds several seats on the account."),
    name: z.string().nullable(),
    email: z.string().nullable(),
    login: z.string().nullable(),
    product: z.string().openapi({ example: "GitHub Copilot" }),
    category: SeatCategory,
    seatType: z.string().openapi({ example: "Copilot Business" }),
    monthlyPrice: z.number().nullable().describe("Per month; null when unpriced."),
    currency: z.string().nullable(),
    priceSource: PriceSource.nullable(),
    priceNote: z.string().nullable(),
    activityBasis: ActivityBasis,
    lastActiveAt: IsoDateTime.nullable(),
    activityWindowDays: z.number().int().nullable(),
    activitySource: z.string().describe("Plain-English description of the evidence."),
    assignedAt: IsoDateTime.nullable(),
    pendingRemovalOn: IsoDateTime.nullable(),
    removable: z.boolean().describe("Whether the in-app Remove can remove it."),
    removalNote: z.string().nullable(),
    downgrade: strict({ seatType: z.string(), price: Price, reason: z.string() }).nullable(),
    context: z.record(z.string(), z.string()),
    resource: strict({ resourceTypeId: z.string(), externalId: z.string() }).nullable(),
    lastSeenAt: IsoDateTime,
    status: SeatStatus,
    daysInactive: z.number().int().nullable(),
    neverActive: z.boolean(),
  }).openapi("Seat");

  const Finding = strict({
    kind: z.enum(["inactive", "duplicate", "downgrade"]),
    seatId: Uuid,
    monthlySaving: z.number().nullable(),
    currency: z.string().nullable(),
    duplicate: strict({
      keptSeatId: Uuid,
      keptProduct: z.string(),
      keptAccountName: z.string(),
      keptLastActiveAt: IsoDateTime.nullable(),
    })
      .optional()
      .describe("For a duplicate: the seat kept (the one used most recently)."),
    targetSeatType: z.string().optional(),
    reason: z.string().optional(),
    remediation: FindingRemediation.optional(),
  }).openapi("SeatFinding");

  const Total = strict({ currency: z.string(), monthly: z.number() }).openapi("SeatTotal");

  const ListResponse = strict({
    inactiveDays: z.number().int(),
    seats: z.array(Seat),
    findings: z.array(Finding).describe("Largest saving first; at most one per seat."),
    savingsMonthly: z.array(Total),
    spendMonthly: z.array(Total),
    counts: strict({
      seats: z.number().int(),
      inactive: z.number().int(),
      duplicate: z.number().int(),
      downgrade: z.number().int(),
      unknownActivity: z.number().int(),
      unpriced: z.number().int(),
    }),
    accounts: z.array(
      strict({
        accountId: Uuid,
        accountName: z.string(),
        pluginId: enums.PluginId,
        pluginName: z.string(),
        seatCount: z.number().int(),
        lastPolledAt: IsoDateTime.nullable(),
        lastError: z.string().nullable(),
      }),
    ),
  }).openapi("SeatListResponse");

  const Settings = strict({
    inactiveDays: z
      .number()
      .int()
      .min(7)
      .max(365)
      .describe("Days without use before a seat is flagged. Default 30."),
  }).openapi("SeatSettings");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/seats",
    tags: ["Seats"],
    summary: "List paid SaaS seats and seat savings findings",
    description:
      "Every paid seat the organization's connected accounts report (Copilot, Cursor, GitLab, " +
      "Okta and others), collected daily, with three findings: inactive for the organization's " +
      "threshold, the same person (by email) paying for two tools in one category, and a " +
      "cheaper tier the member's usage fits. Each finding carries remediation commands.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Seats and findings",
        content: { "application/json": { schema: ListResponse } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/seats/refresh",
    tags: ["Seats"],
    summary: "Re-collect seats now",
    description: "Makes every seat-capable account due; the poller collects within minutes.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Accounts queued",
        content: {
          "application/json": { schema: strict({ queued: z.number().int() }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/seats/settings",
    tags: ["Seats"],
    summary: "Get the seat settings",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Seat settings", content: { "application/json": { schema: Settings } } },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/seats/settings",
    tags: ["Seats"],
    summary: "Update the seat settings",
    description:
      "`inactiveDays` must be a whole number from 7 to 365; it is rejected, not clamped.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: Settings } } },
    },
    responses: {
      200: {
        description: "The saved settings",
        content: { "application/json": { schema: Settings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/seats/{seatId}/remove",
    tags: ["Seats"],
    summary: "Remove a flagged seat",
    description:
      "Removes a seat currently flagged inactive or duplicated through the provider's API and " +
      "records the realized saving. Refused (409) for a seat that is not a finding. Blocked " +
      "by an active change freeze (423).",
    request: { params: OrgIdParam.extend({ seatId: Uuid }) },
    responses: {
      200: {
        description: "Removed",
        content: {
          "application/json": {
            schema: strict({
              effective: z.enum(["immediate", "end-of-cycle"]),
              message: z.string().nullable(),
            }).openapi("SeatRemovalResponse"),
          },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
}
