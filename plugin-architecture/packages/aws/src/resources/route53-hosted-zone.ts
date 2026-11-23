import { f, o, rt } from "@infrawrench/plugin-base";

export const Route53HostedZoneResourceType = rt({
  name: "Route 53 Hosted Zone",
  id: "route53-hosted-zone",
  description: "An Amazon Route 53 DNS hosted zone",
  equivalence: "dns-zone",
  fields: [
    f("name", "Domain Name"),
    f("hostedZoneId", "Hosted Zone ID"),
    // 10,000 records per hosted zone by default (raised on request, at extra
    // cost): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html
    // (read 2026-11-23). A raised zone reads early against this.
    f("recordCount", "Record Count", {
      showcase: true,
      kind: "number",
      required: false,
      usage: { limit: { constant: 10_000 }, unit: "records", label: "Records" },
    }),
    f("isPrivate", "Private Zone", { kind: "boolean", required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [o("hostedZoneId", "Hosted Zone ID"), o("nameServers", "Name Servers")],
  supportsCreate: true,
  iconKey: "dns",
  dnsRole: {
    role: "zone",
    domainKey: "name",
    recordCountKey: "recordCount",
    privateKey: "isPrivate",
  },
});
