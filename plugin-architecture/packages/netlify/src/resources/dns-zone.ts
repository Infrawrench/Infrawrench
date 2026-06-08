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
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
  ],
  outputs: [o("zoneId", "Zone ID"), o("domain", "Domain")],
  supportsCreate: true,
  iconKey: "dns",
  attachTargets: [
    {
      pluginId: "netlify",
      resourceTypeId: "netlify-site",
      verb: "Attach domain",
    },
  ],
});
