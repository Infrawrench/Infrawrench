/**
 * DNS inventory: `/api/org/:orgId/dns`, the endpoint definitions.
 *
 * The inventory is assembled in server-core (`dns/feed.ts`) so the web API,
 * the MCP tool and the posture pass share one computation. Purely a read over
 * already-synced state: no provider API calls, and no DNS resolution.
 *
 * There is no settings sibling here on purpose. Dangling records alert as
 * posture findings, so the on/off switch is `/posture/settings`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { PluginId } from "../../schemas/plugin-registry";

const classifications = ["owned", "dangling", "external", "not-analysed"] as const;

const DnsTargetClassification = Schema.Literals(classifications).annotate({
  description:
    "What can be said about a record target from synced state alone. " +
    "`owned`: the value is an identity of a synced resource. " +
    "`dangling`: the value falls inside a provider namespace this workspace manages " +
    "(an S3 endpoint, a `*.vercel.app` alias) and no synced resource claims it, which is " +
    "the subdomain-takeover signature. " +
    "`external`: the value points somewhere there is no declaration for; not a finding. " +
    "`not-analysed`: the record type carries no host target that is reasoned about (TXT, MX, SOA, CAA, SRV).",
});

const DnsTargetResource = Schema.Struct({
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["S3 Bucket"] }),
  accountId: Uuid,
}).annotate({ identifier: "DnsTargetResource" });

const DnsTargetService = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["Vercel"] }),
  resourceTypeId: Schema.String,
  ruleId: Schema.String.annotate({ examples: ["vercel-alias"] }),
  label: Schema.String.annotate({ examples: ["Vercel deployment alias"] }),
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  reason: Schema.String.annotate({
    description: "Plugin-authored note on what claiming the name gets an attacker.",
  }),
  claimLabel: Schema.String.annotate({
    description: "The instance-identifying part of the hostname, e.g. the bucket or app name.",
  }),
}).annotate({ identifier: "DnsTargetService" });

const DnsRecordTarget = Schema.Struct({
  value: Schema.String.annotate({
    description: "The target as stored, lowercased with any trailing dot removed.",
  }),
  classification: DnsTargetClassification,
  resource: Schema.NullOr(DnsTargetResource).annotate({
    description: 'Set only when classification is "owned".',
  }),
  service: Schema.NullOr(DnsTargetService).annotate({
    description: 'Set only when classification is "dangling".',
  }),
}).annotate({ identifier: "DnsRecordTarget" });

const DnsRecord = Schema.Struct({
  resourceId: Schema.String.annotate({
    description: "Infrawrench resource id of the record itself.",
  }),
  pluginId: PluginId,
  pluginName: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  accountId: Uuid,
  accountName: Schema.String,
  zoneResourceId: Schema.NullOr(Schema.String).annotate({
    description: "Owning zone's resource id, or null when the record could not be attributed.",
  }),
  zoneDomain: Schema.NullOr(Schema.String),
  name: Schema.String.annotate({ description: "Fully qualified, lowercased, no trailing dot." }),
  type: Schema.String.annotate({ examples: ["CNAME"] }),
  ttl: Schema.NullOr(Schema.Finite),
  priority: Schema.NullOr(Schema.Finite),
  proxied: Schema.Boolean.annotate({
    description: "Whether the provider proxies the record (Cloudflare's orange cloud).",
  }),
  targets: Schema.Array(DnsRecordTarget),
  status: Schema.Literals(classifications).annotate({
    description: "Worst classification across `targets`.",
  }),
}).annotate({ identifier: "DnsRecord" });

const DnsZone = Schema.Struct({
  resourceId: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  accountId: Uuid,
  accountName: Schema.String,
  domain: Schema.String.annotate({ examples: ["example.com"] }),
  status: Schema.NullOr(Schema.String),
  isPrivate: Schema.Boolean.annotate({
    description: "Split-horizon/internal zone; listed but never analysed for takeover.",
  }),
  recordCount: Schema.Int.annotate({ description: "Records synced into this zone." }),
  providerRecordCount: Schema.NullOr(Schema.Int).annotate({
    description:
      "The provider's own record count, when reported. May exceed `recordCount`: several " +
      "plugins list zones without listing their records.",
  }),
  danglingCount: Schema.Int,
}).annotate({ identifier: "DnsZone" });

const DnsSkippedNamespace = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  label: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "DnsSkippedNamespace" });

const DnsInventoryCounts = Schema.Struct({
  zones: Schema.Int,
  records: Schema.Int,
  owned: Schema.Int,
  dangling: Schema.Int,
  external: Schema.Int,
  notAnalysed: Schema.Int,
}).annotate({ identifier: "DnsInventoryCounts" });

export const DnsInventoryResponse = Schema.Struct({
  zones: Schema.Array(DnsZone).annotate({ description: "Sorted by domain, then account name." }),
  records: Schema.Array(DnsRecord).annotate({
    description: "Sorted worst status first, then by name.",
  }),
  counts: DnsInventoryCounts.annotate({
    description: "Record counts per status; zones counted separately.",
  }),
  skippedNamespaces: Schema.Array(DnsSkippedNamespace).annotate({
    description:
      "Provider namespaces that were declared but not evaluated, and why; either no account " +
      "for the plugin is connected, or no claimant resource has synced. Both are missing data " +
      "rather than a clean bill of health, so they are reported rather than hidden.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "DnsInventoryResponse" });

export class DnsGroup extends HttpApiGroup.make("dns")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: DnsInventoryResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List every DNS zone and record, with dangling targets flagged")
      .annotate(
        OpenApi.Description,
        "One view over every zone and record across the connected DNS providers (Cloudflare, " +
          "Route 53, Cloud DNS, DigitalOcean, Netlify, Azure DNS, Vercel), with each record target " +
          "classified against the rest of the workspace. No provider API calls are made and no DNS " +
          "is resolved: results reflect the last sync.\n\n" +
          "A `dangling` target is a subdomain-takeover candidate: the record points into a provider " +
          "namespace this workspace manages and nothing synced claims it. The same records surface " +
          "as `dns-dangling-target` findings on `GET /posture` and alert through the posture " +
          "channel, so there is no separate DNS alert setting.",
      )
      .annotate(SuccessDescription, "The organization's DNS inventory"),
  )
  .prefix("/api/org/:orgId/dns")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "DNS") {}

export class DnsApi extends withApiDefaults(HttpApi.make("dns").add(DnsGroup)) {}
