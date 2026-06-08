import { f, o, rt } from "@infrawrench/plugin-base";

export const Route53RecordSetResourceType = rt({
  name: "Route 53 Record",
  pinnable: false,
  id: "route53-record-set",
  description: "A DNS record in an Amazon Route 53 hosted zone",
  parentTypeId: "route53-hosted-zone",
  fields: [
    f("name", "Record Name"),
    f("type", "Record Type", {
      kind: "enum",
      enumValues: ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "SOA", "PTR", "CAA", "ALIAS"],
    }),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("values", "Values", { required: false }),
    f("hostedZoneId", "Hosted Zone ID"),
  ],
  outputs: [],
  iconKey: "dns",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "aws", resourceTypeId: "alb", verb: "Point alias" },
    { pluginId: "aws", resourceTypeId: "cloudfront-distribution", verb: "Point alias" },
  ],
});
