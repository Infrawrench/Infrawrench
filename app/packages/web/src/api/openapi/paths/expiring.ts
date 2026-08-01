import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ExpirySeverity = z.enum(["expired", "critical", "warning", "upcoming", "ok"]).openapi({
  description:
    "How close the deadline is: `expired` (in the past), `critical` (due within 7 days), " +
    "`warning` (within 30 days), `upcoming` (within the organization's lead time), or `ok` " +
    "(tracked, but further out than the lead time).",
});

const ExpiryKind = z
  .enum([
    "tls-cert",
    "domain",
    "api-token",
    "access-key",
    "k8s-cert",
    "ssh-key",
    "secret-version",
    "other",
  ])
  .openapi({ description: "Grouping bucket for the kind of deadline." });

export function registerExpiringPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const ExpiryItem = strict({
    resourceId: z.string().describe("Infrawrench resource id."),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "Cloudflare" }),
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "ACM Certificate" }),
    accountId: Uuid,
    accountName: z.string(),
    displayName: z.string(),
    externalId: z.string().nullable().describe("Provider-native id, when known."),
    fieldKey: z.string().describe("The declared field the deadline came from."),
    kind: ExpiryKind,
    label: z
      .string()
      .describe("Plugin-authored caption for the deadline.")
      .openapi({ example: "Certificate expires" }),
    basis: z.enum(["expiry", "age"]).openapi({
      description:
        "`expiry` — the field held the deadline itself; `age` — the deadline was derived " +
        "from a creation/rotation date plus an age budget.",
    }),
    dueAt: IsoDateTime.describe("The deadline."),
    daysRemaining: z
      .number()
      .int()
      .describe("Whole days until dueAt (floor); negative once expired."),
    severity: ExpirySeverity,
  }).openapi("ExpiryItem");

  const ExpirySeverityCounts = strict({
    expired: z.number().int(),
    critical: z.number().int(),
    warning: z.number().int(),
    upcoming: z.number().int(),
    ok: z.number().int(),
  }).openapi("ExpirySeverityCounts");

  const ExpiryListResponse = strict({
    items: z
      .array(ExpiryItem)
      .describe("All tracked deadlines, soonest first (`ok` items included)."),
    totalCount: z.number().int(),
    counts: ExpirySeverityCounts.describe(
      "Item count per severity; every bucket present, zeros included.",
    ),
    leadDays: z
      .number()
      .int()
      .describe("The lead time the `upcoming` bucket was computed against."),
    generatedAt: IsoDateTime,
  }).openapi("ExpiryListResponse");

  const ExpirySettings = strict({
    enabled: z.boolean().openapi({
      description: "Whether the poller sends expiry alerts for this organization at all.",
    }),
    leadDays: z.number().int().min(1).max(365).openapi({
      description:
        "Days of lead time before a deadline counts as `upcoming` and alertable. Default 60.",
    }),
    lastNotifiedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({
        description:
          "When the organization's expiry alert scan last completed, or null before the first. " +
          "Owned by the poller's cooldown claim; not writable through this API.",
      }),
  }).openapi("ExpiryAlertSettings");

  const ExpirySettingsUpdate = strict({
    enabled: z.boolean().optional(),
    leadDays: z.number().int().min(1).max(365).optional(),
  }).openapi("ExpiryAlertSettingsUpdate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/expiring",
    tags: ["Expiry radar"],
    summary: "List approaching deadlines on synced resources",
    description:
      "One cross-provider countdown of everything with a clock on it: TLS certificate " +
      "expiries, domain registrations, API token expirations, access keys past their " +
      "rotation budget, Kubernetes/SSH credential ages. Plugins declare which synced fields " +
      "carry deadlines; the feed is computed over already-stored state, so no provider API " +
      "calls are made and results reflect the last sync. Items are sorted soonest first and " +
      "bucketed by severity against the organization's lead time.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Tracked deadlines, soonest first",
        content: { "application/json": { schema: ExpiryListResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/expiring/settings",
    tags: ["Expiry radar"],
    summary: "Get the organization's expiry alert settings",
    description:
      "The lead time feeds both the feed's `upcoming` bucket and the poller's daily alert " +
      "scan. An organization that never saved reads the shipped defaults (enabled, 60 days).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Expiry alert settings",
        content: { "application/json": { schema: ExpirySettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/expiring/settings",
    tags: ["Expiry radar"],
    summary: "Update the expiry alert settings",
    description:
      "Every field is optional so a single toggle can be saved on its own. `leadDays` must " +
      "be a whole number from 1 to 365. Saving never resets the alert cooldown.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ExpirySettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: ExpirySettings } },
      },
      400: ErrorResponses[400],
    },
  });
}
