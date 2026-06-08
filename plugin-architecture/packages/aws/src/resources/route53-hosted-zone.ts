import { f, o, rt } from "@infrawrench/plugin-base";

export const Route53HostedZoneResourceType = rt({
  name: "Route 53 Hosted Zone",
  id: "route53-hosted-zone",
  description: "An Amazon Route 53 DNS hosted zone",
  fields: [
    f("name", "Domain Name"),
    f("hostedZoneId", "Hosted Zone ID"),
    f("recordCount", "Record Count", { kind: "number", required: false }),
    f("isPrivate", "Private Zone", { kind: "boolean", required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [o("hostedZoneId", "Hosted Zone ID"), o("nameServers", "Name Servers")],
  supportsCreate: true,
  iconKey: "dns",
});
