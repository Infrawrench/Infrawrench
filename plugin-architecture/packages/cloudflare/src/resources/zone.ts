import { f, o, rt } from "@infrawrench/plugin-base";

export const ZoneResourceType = rt({
  name: "Zone",
  id: "zone",
  description: "A Cloudflare DNS zone (domain)",
  fields: [
    f("name", "Domain"),
    f("status", "Status"),
    f("plan", "Plan", { required: false }),
    f("nameservers", "Nameservers", { required: false }),
    f("type", "Zone Type", { required: false }),
    f("paused", "Paused", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("zoneId", "Zone ID"),
    o("nameservers", "Nameservers", {
      description: "Cloudflare nameservers assigned to this zone",
    }),
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "dns",
  secretExportTemplates: [
    {
      id: "zone-id",
      displayName: "Zone ID",
      description: "Zone ID for Cloudflare API / wrangler operations",
      entries: [{ envKey: "CLOUDFLARE_ZONE_ID", outputKey: "zoneId" }],
    },
  ],
  postureChecks: [
    {
      id: "cloudflare-zone-paused",
      title: "Zone paused — proxy bypassed",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "paused", when: "truthy" }],
      reason:
        "The zone is paused: traffic goes straight to your origin, bypassing Cloudflare's proxy, WAF and DDoS protection, and exposing origin IPs.",
    },
  ],
});
