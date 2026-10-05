import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ExtendedSupportStatus = z
  .enum(["end-of-life", "surcharged", "unsupported", "upcoming"])
  .openapi({
    description:
      "`surcharged`: past standard support and paying for extended support. `unsupported`: " +
      "past standard support with no surcharge (no paid extension, or not enrolled), so a " +
      "forced upgrade is pending. `end-of-life`: past the end of extended support too. " +
      "`upcoming`: standard support ends within the organization's lead time.",
  });

const ExtendedSupportUnit = z.enum([
  "cluster-hour",
  "vcpu-hour",
  "vcore-hour",
  "node-hour",
  "instance-hour",
  "acu-hour",
]);

const CostBasis = z.enum(["billed", "billed-share", "list-price", "unpriced"]).openapi({
  description:
    "Where `monthlySurcharge` came from: `billed` (the provider's billing, attributable to " +
    "this resource alone), `billed-share` (a billed line shared by several matching " +
    "resources, split by list-price weight), `list-price` (computed from published rates), " +
    "or `unpriced` (no figure).",
});

export function registerExtendedSupportPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const Total = strict({
    currency: z.string().openapi({ example: "USD" }),
    monthly: z.number(),
  }).openapi("ExtendedSupportTotal");

  const Finding = strict({
    resourceId: z.string().describe("Infrawrench resource id."),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "AWS" }),
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "EKS Cluster" }),
    accountId: Uuid,
    accountName: z.string(),
    displayName: z.string(),
    externalId: z.string().nullable(),
    region: z.string().nullable(),
    releaseId: z
      .string()
      .describe("The matched support-calendar entry, unique within the resource type.")
      .openapi({ example: "k8s-1.30" }),
    product: z.string().openapi({ example: "Amazon EKS" }),
    engine: z.string().nullable(),
    currentVersion: z.string().openapi({ example: "1.30" }),
    targetVersion: z.string().openapi({ example: "1.35" }),
    status: ExtendedSupportStatus,
    standardSupportEnds: z.string().describe("Last day of standard support, YYYY-MM-DD."),
    surchargeStartsOn: z.string().describe("First day the surcharge applies, YYYY-MM-DD."),
    daysUntilSurcharge: z.number().int().describe("Zero or negative once it has started."),
    extendedSupportEnds: z
      .string()
      .nullable()
      .describe("Last day of extended support, after which the provider upgrades it."),
    daysUntilForcedUpgrade: z.number().int().nullable(),
    charged: z
      .boolean()
      .describe("False when there is no paid extension or the resource is not enrolled."),
    quantity: z.number().nullable().describe("Billable units (vCPUs, nodes); null when unknown."),
    unit: ExtendedSupportUnit.nullable(),
    currency: z.string().nullable(),
    tierLabel: z.string().nullable().describe("The rate tier in force (or first, if upcoming)."),
    monthlySurcharge: z
      .number()
      .nullable()
      .describe(
        "Monthly surcharge an upgrade removes (projected for `upcoming`). Null means no figure.",
      ),
    listMonthlySurcharge: z.number().nullable().describe("The list-price figure."),
    costBasis: CostBasis,
    billedLineItems: z.array(z.string()).describe("Provider line items behind a billed figure."),
    nextTier: strict({
      from: z.string(),
      label: z.string(),
      monthlySurcharge: z.number().nullable(),
    })
      .nullable()
      .describe("The next, higher rate tier, when the rate is scheduled to rise."),
    priceNote: z.string().nullable(),
    pricingUrl: z.string().nullable(),
    upgradeUrl: z.string(),
    note: z.string().nullable(),
  }).openapi("ExtendedSupportFinding");

  const Unattributed = strict({
    resourceTypeId: z.string().optional(),
    releaseId: z.string().optional(),
    region: z.string().optional(),
    engine: z.string().optional(),
    lineItem: z.string().describe("Provider line item, e.g. an AWS usage type."),
    amount: z.number().describe("Billed over the window."),
    currency: z.string(),
    accountId: Uuid,
    accountName: z.string(),
    monthlyAmount: z.number(),
  }).openapi("UnattributedExtendedSupportCharge");

  const ListResponse = strict({
    findings: z.array(Finding).describe("Most urgent first, then largest surcharge."),
    totalCount: z.number().int(),
    counts: strict({
      "end-of-life": z.number().int(),
      surcharged: z.number().int(),
      unsupported: z.number().int(),
      upcoming: z.number().int(),
    }),
    currentMonthly: z.array(Total).describe("What surcharged and end-of-life findings cost now."),
    upcomingMonthly: z.array(Total).describe("What upcoming findings will add once they start."),
    leadDays: z.number().int(),
    billing: strict({
      windowDays: z.number().int(),
      accounts: z.array(
        strict({
          accountId: Uuid,
          accountName: z.string(),
          status: z.enum(["read", "failed"]),
          error: z.string().optional(),
        }),
      ),
      unattributed: z.array(Unattributed),
    })
      .optional()
      .describe("Present when billed charges were read for at least one account."),
    generatedAt: IsoDateTime,
  }).openapi("ExtendedSupportListResponse");

  const Settings = strict({
    enabled: z.boolean().describe("Whether the weekly extended-support alert is sent."),
    leadDays: z
      .number()
      .int()
      .describe("Days ahead an upcoming surcharge is listed for. Default 90."),
    lastNotifiedAt: z
      .string()
      .datetime()
      .nullable()
      .describe("When the last weekly alert scan completed. Owned by the poller; read-only."),
  }).openapi("ExtendedSupportSettings");

  const SettingsUpdate = strict({
    enabled: z.boolean().optional(),
    leadDays: z.number().int().min(1).max(365).optional(),
  }).openapi("ExtendedSupportSettingsUpdate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/extended-support",
    tags: ["Orphans"],
    summary: "List resources billed at extended-support or end-of-life rates",
    description:
      "Matches every synced resource's version against its provider's support calendar " +
      "(declared by the plugin): resources paying an extended-support surcharge, past the end " +
      "of support, or whose standard support ends within the lead time. Each finding carries " +
      "the monthly surcharge an upgrade removes: the provider's billed amount where it can be " +
      "attributed (AWS Cost Explorer extended-support usage types), otherwise list price. " +
      "Results are cached for a few minutes; pass `refresh=true` to recompute.",
    request: {
      params: OrgIdParam,
      query: strict({
        refresh: z
          .enum(["true", "false"])
          .optional()
          .describe("Bypass the short server-side cache and recompute now."),
      }),
    },
    responses: {
      200: {
        description: "Extended-support findings",
        content: { "application/json": { schema: ListResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/extended-support/settings",
    tags: ["Orphans"],
    summary: "Get the organization's extended-support settings",
    description: "An organization that never saved reads the shipped defaults (enabled, 90 days).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Extended-support settings",
        content: { "application/json": { schema: Settings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/extended-support/settings",
    tags: ["Orphans"],
    summary: "Update the extended-support settings",
    description:
      "Every field is optional. `leadDays` must be a whole number from 1 to 365. Saving never " +
      "resets the alert cooldown.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: Settings } },
      },
      400: ErrorResponses[400],
    },
  });
}
