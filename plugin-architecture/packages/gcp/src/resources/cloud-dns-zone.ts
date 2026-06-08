import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudDnsZoneResourceType = rt({
  name: "Cloud DNS Zone",
  id: "cloud-dns-zone",
  description: "A Google Cloud DNS managed zone",
  fields: [
    f("name", "Name"),
    f("dnsName", "DNS Name"),
    f("description", "Description", { required: false }),
    f("visibility", "Visibility", { required: false }),
    f("nameservers", "Nameservers", { required: false }),
    f("dnssecState", "DNSSEC", { required: false }),
    f("recordCount", "Record Count", { kind: "number", required: false }),
  ],
  outputs: [
    o("nameservers", "Nameservers", { description: "Google Cloud DNS nameservers for this zone" }),
  ],
  supportsCreate: true,
  iconKey: "dns",
});
