import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const QuotaSeverity = z.enum(["exhausted", "critical", "trending", "ok"]).openapi({
  description:
    "Where the quota sits: `exhausted` (used >= limit — the provider is already refusing " +
    "requests), `critical` (at or over the organization's threshold), `trending` (under the " +
    "threshold, but the fitted trend reaches the limit within 30 days), or `ok`. Ordered: an " +
    "exhausted quota is also over threshold and also trending, and reports as `exhausted`.",
});

export function registerQuotaPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const QuotaTrend = strict({
    perDay: z
      .number()
      .nullable()
      .describe(
        "Least-squares change in utilisation fraction per day over the last 14 days of " +
          "snapshots. Null when fewer than 3 readings exist, or when every reading shares " +
          "an instant. Null means 'not enough history', never 'no risk'.",
      ),
    daysToExhaustion: z
      .number()
      .nullable()
      .describe(
        "Days until used reaches limit at the fitted rate. Null when the trend is flat or " +
          "falling, when the quota is already at its limit, or when exhaustion lands beyond " +
          "the 30-day horizon.",
      ),
    points: z.number().int().describe("Snapshots the fit used."),
  }).openapi("QuotaTrend");

  const QuotaRow = strict({
    key: z
      .string()
      .describe("Plugin-chosen stable id for this quota within the account.")
      .openapi({ example: "ec2/L-1216C47A/eu-west-1" }),
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    service: z
      .string()
      .describe("Provider service in the provider's own vocabulary.")
      .openapi({ example: "ec2" }),
    name: z.string().openapi({ example: "Running On-Demand Standard instances" }),
    region: z
      .string()
      .nullable()
      .describe("Provider region, or null for an account-wide quota. Never the string 'global'."),
    limit: z.number().describe("The ceiling the provider will enforce, in `unit`."),
    used: z.number().describe("How much of `limit` is consumed, in the same unit."),
    utilization: z
      .number()
      .describe("used / limit. Not clamped at 1 — an over-quota reading is a real state."),
    unit: z
      .string()
      .nullable()
      .describe("What is being counted, in the provider's own word.")
      .openapi({ example: "vCPUs" }),
    adjustable: z
      .boolean()
      .nullable()
      .describe(
        "Whether the provider lets the customer request an increase. Null means the plugin " +
          "does not know, which is not the same as `false`.",
      ),
    docsUrl: z.string().nullable().describe("Provider page explaining or raising this quota."),
    observedAt: IsoDateTime.describe("When this reading was collected."),
    severity: QuotaSeverity,
    trend: QuotaTrend,
  }).openapi("QuotaRow");

  const QuotaAccountStatus = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    quotaCount: z.number().int().describe("Quota rows currently stored for this account."),
    lastPolledAt: IsoDateTime.nullable().describe("Last successful collection; null if never."),
    lastError: z
      .string()
      .nullable()
      .describe("Last collection failure, or null when the last pass succeeded."),
    lastErrorHelpLabel: z.string().nullable(),
    lastErrorHelpUrl: z
      .string()
      .nullable()
      .describe("Set when the failure was a fixable permission gap rather than an outage."),
    partial: z
      .boolean()
      .describe(
        "The plugin reports a representative subset of the provider's quotas, not all of " +
          "them. True for AWS and DigitalOcean.",
      ),
  }).openapi("QuotaAccountStatus");

  const QuotaListResponse = strict({
    rows: z.array(QuotaRow).describe("Every quota with a reading, worst first."),
    accounts: z
      .array(QuotaAccountStatus)
      .describe(
        "Per-account collection status for every account on a quota-capable plugin. Present " +
          "even when the account has rows: an empty `rows` alone cannot distinguish 'nothing " +
          "is near a limit' from 'every collection is failing'.",
      ),
    threshold: z
      .number()
      .describe(
        "The organization's alert threshold as a fraction, so the page's marker and " +
          "the alert agree.",
      ),
    unsupportedPluginIds: z
      .array(enums.PluginId)
      .describe(
        "Plugins the organization holds accounts with that cannot report quotas at all. " +
          "Named rather than counted, because the absence is the finding.",
      ),
  }).openapi("QuotaListResponse");

  const QuotaSettings = strict({
    enabled: z.boolean().openapi({
      description: "Whether the poller sends quota alerts for this organization at all.",
    }),
    threshold: z
      .number()
      .min(0.5)
      .max(0.99)
      .openapi({
        description:
          "Utilisation fraction at or above which a quota alerts. Default 0.8. Bounded below " +
          "at 0.5 (a lower threshold makes every quota critical) and above at 0.99 (at 1.0 " +
          "the provider is already refusing requests, so the alert reports an outage rather " +
          "than warning about one). Values outside the range are rejected, not clamped.",
      }),
    lastNotifiedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({
        description:
          "When the organization's quota alert scan last completed, or null before the " +
          "first. Owned by the poller's cooldown claim; not writable through this API.",
      }),
  }).openapi("QuotaAlertSettings");

  const QuotaSettingsUpdate = strict({
    enabled: z.boolean().optional(),
    threshold: z.number().min(0.5).max(0.99).optional(),
  }).openapi("QuotaAlertSettingsUpdate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/quotas",
    tags: ["Quota radar"],
    summary: "List provider quota utilisation across the organization",
    description:
      "How close each account is to the limits its provider enforces, with the trend fitted " +
      "over the last 14 days of collected readings. Both halves of every row — the used " +
      "figure and the limit — come from the provider; nothing is filled in from published " +
      "defaults, so an account with an approved increase reads as having the headroom it " +
      "has. This is a read over already-collected snapshots: no provider API calls are made " +
      "here, and the readings are as fresh as the last collection pass (roughly six hours). " +
      "A plugin that declares no quota capability contributes nothing rather than zero — see " +
      "`unsupportedPluginIds`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Quota readings, worst first, with per-account collection status",
        content: { "application/json": { schema: QuotaListResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/quotas/settings",
    tags: ["Quota radar"],
    summary: "Get the organization's quota alert settings",
    description:
      "The threshold feeds both the feed's severity buckets and the poller's daily alert " +
      "scan. An organization that never saved reads the shipped defaults (enabled, 0.8).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Quota alert settings",
        content: { "application/json": { schema: QuotaSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/quotas/settings",
    tags: ["Quota radar"],
    summary: "Update the quota alert settings",
    description:
      "Every field is optional so a single toggle can be saved on its own. `threshold` is a " +
      "fraction from 0.5 to 0.99 and is rejected rather than clamped when out of range. " +
      "Saving never resets the alert cooldown.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: QuotaSettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: QuotaSettings } },
      },
      400: ErrorResponses[400],
    },
  });
}
