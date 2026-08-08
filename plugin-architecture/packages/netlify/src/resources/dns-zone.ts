import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyDnsZoneResourceType = rt({
  name: "DNS Zone",
  id: "netlify-dns-zone",
  description: "A Netlify Managed DNS zone",
  fields: [
    f("name", "Name"),
    f("domain", "Domain", { required: false }),
    f("dnsServers", "DNS Servers", { required: false }),
    f("supportedRecordTypes", "Supported Record Types", { required: false }),
    f("ipv6Enabled", "IPv6 Enabled", { kind: "boolean", required: false }),
    f("dedicated", "Dedicated", { kind: "boolean", required: false }),
    f("accountName", "Team", { required: false }),
    f("siteId", "Site", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
  ],
  outputs: [o("zoneId", "Zone ID"), o("domain", "Domain")],
  // Netlify returns `site_id` on a zone when the zone was created for a site.
  dependsOn: [{ fieldKey: "siteId", targetTypeId: "netlify-site", label: "for site" }],
  supportsCreate: true,
  iconKey: "dns",
  dnsRole: { role: "zone", domainKey: "name" },
  attachTargets: [
    {
      pluginId: "netlify",
      resourceTypeId: "netlify-site",
      verb: "Attach domain",
    },
  ],
});
