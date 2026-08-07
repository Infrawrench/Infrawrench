import { f, o, rt } from "@infrawrench/plugin-base";

export const DomainResourceType = rt({
  name: "Domain",
  id: "domain",
  description: "A DigitalOcean DNS domain",
  fields: [
    f("name", "Domain"),
    f("ttl", "Default TTL", { kind: "number", required: false }),
    f("zoneFile", "Zone File", { required: false }),
  ],
  outputs: [
    o("nameservers", "Nameservers", { description: "DigitalOcean nameservers for this domain" }),
  ],
  supportsCreate: true,
  iconKey: "dns",
  dnsRole: { role: "zone", domainKey: "name" },
});
