import { f, o, rt } from "@infrawrench/plugin-base";

export const DnsZoneResourceType = rt({
  id: "dns-zone",
  name: "DNS Zone",
  description: "A Scaleway Domains and DNS zone",
  fields: [
    f("name", "Zone"),
    f("domain", "Domain", { required: false }),
    f("subdomain", "Subdomain", { required: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["active", "pending", "error", "locked"],
    }),
    f("nameservers", "Nameservers", { required: false }),
    f("message", "Message", { required: false }),
  ],
  outputs: [o("nameservers", "Nameservers")],
  supportsCreate: true,
  iconKey: "dns",
  dnsRole: { role: "zone", domainKey: "name", statusKey: "status" },
});
