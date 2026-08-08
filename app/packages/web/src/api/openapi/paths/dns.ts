import { z } from "../zod";
import { strict, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const DnsTargetClassification = z.enum(["owned", "dangling", "external", "not-analysed"]).openapi({
  description:
    "What can be said about a record target from synced state alone. " +
    "`owned` — the value is an identity of a synced resource. " +
    "`dangling` — the value falls inside a provider namespace this workspace manages " +
    "(an S3 endpoint, a `*.vercel.app` alias) and no synced resource claims it, which is " +
    "the subdomain-takeover signature. " +
    "`external` — the value points somewhere there is no declaration for; not a finding. " +
    "`not-analysed` — the record type carries no host target that is reasoned about (TXT, MX, SOA, CAA, SRV).",
});

export function registerDnsPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const DnsTargetResource = strict({
    resourceId: z.string(),
    displayName: z.string(),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "S3 Bucket" }),
    accountId: Uuid,
  }).openapi("DnsTargetResource");

  const DnsTargetService = strict({
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "Vercel" }),
    resourceTypeId: z.string(),
    ruleId: z.string().openapi({ example: "vercel-alias" }),
    label: z.string().openapi({ example: "Vercel deployment alias" }),
    severity: z.enum(["critical", "high", "medium", "low"]),
    reason: z.string().describe("Plugin-authored note on what claiming the name gets an attacker."),
    claimLabel: z
      .string()
      .describe("The instance-identifying part of the hostname, e.g. the bucket or app name."),
  }).openapi("DnsTargetService");

  const DnsRecordTarget = strict({
    value: z.string().describe("The target as stored, lowercased with any trailing dot removed."),
    classification: DnsTargetClassification,
    resource: DnsTargetResource.nullable().describe('Set only when classification is "owned".'),
    service: DnsTargetService.nullable().describe('Set only when classification is "dangling".'),
  }).openapi("DnsRecordTarget");

  const DnsRecord = strict({
    resourceId: z.string().describe("Infrawrench resource id of the record itself."),
    pluginId: enums.PluginId,
    pluginName: z.string(),
    resourceTypeId: z.string(),
    resourceTypeName: z.string(),
    accountId: Uuid,
    accountName: z.string(),
    zoneResourceId: z
      .string()
      .nullable()
      .describe("Owning zone's resource id, or null when the record could not be attributed."),
    zoneDomain: z.string().nullable(),
    name: z.string().describe("Fully qualified, lowercased, no trailing dot."),
    type: z.string().openapi({ example: "CNAME" }),
    ttl: z.number().nullable(),
    priority: z.number().nullable(),
    proxied: z
      .boolean()
      .describe("Whether the provider proxies the record (Cloudflare's orange cloud)."),
    targets: z.array(DnsRecordTarget),
    status: DnsTargetClassification.openapi({
      description: "Worst classification across `targets`.",
    }),
  }).openapi("DnsRecord");

  const DnsZone = strict({
    resourceId: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string(),
    resourceTypeId: z.string(),
    resourceTypeName: z.string(),
    accountId: Uuid,
    accountName: z.string(),
    domain: z.string().openapi({ example: "example.com" }),
    status: z.string().nullable(),
    isPrivate: z
      .boolean()
      .describe("Split-horizon/internal zone; listed but never analysed for takeover."),
    recordCount: z.number().int().describe("Records synced into this zone."),
    providerRecordCount: z
      .number()
      .int()
      .nullable()
      .describe(
        "The provider's own record count, when reported. May exceed `recordCount` — several " +
          "plugins list zones without listing their records.",
      ),
    danglingCount: z.number().int(),
  }).openapi("DnsZone");

  const DnsSkippedNamespace = strict({
    pluginId: enums.PluginId,
    pluginName: z.string(),
    label: z.string(),
    reason: z.string(),
  }).openapi("DnsSkippedNamespace");

  const DnsInventoryCounts = strict({
    zones: z.number().int(),
    records: z.number().int(),
    owned: z.number().int(),
    dangling: z.number().int(),
    external: z.number().int(),
    notAnalysed: z.number().int(),
  }).openapi("DnsInventoryCounts");

  const DnsInventoryResponse = strict({
    zones: z.array(DnsZone).describe("Sorted by domain, then account name."),
    records: z.array(DnsRecord).describe("Sorted worst status first, then by name."),
    counts: DnsInventoryCounts.describe("Record counts per status; zones counted separately."),
    skippedNamespaces: z
      .array(DnsSkippedNamespace)
      .describe(
        "Provider namespaces that were declared but not evaluated, and why — either no account " +
          "for the plugin is connected, or no claimant resource has synced. Both are missing data " +
          "rather than a clean bill of health, so they are reported rather than hidden.",
      ),
    generatedAt: IsoDateTime,
  }).openapi("DnsInventoryResponse");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dns",
    tags: ["DNS"],
    summary: "List every DNS zone and record, with dangling targets flagged",
    description:
      "One view over every zone and record across the connected DNS providers (Cloudflare, " +
      "Route 53, Cloud DNS, DigitalOcean, Netlify, Azure DNS, Vercel), with each record target " +
      "classified against the rest of the workspace. No provider API calls are made and no DNS " +
      "is resolved — results reflect the last sync.\n\n" +
      "A `dangling` target is a subdomain-takeover candidate: the record points into a provider " +
      "namespace this workspace manages and nothing synced claims it. The same records surface " +
      "as `dns-dangling-target` findings on `GET /posture` and alert through the posture " +
      "channel, so there is no separate DNS alert setting.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's DNS inventory",
        content: { "application/json": { schema: DnsInventoryResponse } },
      },
    },
  });
}
