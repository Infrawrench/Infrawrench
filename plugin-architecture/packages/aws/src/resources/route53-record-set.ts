import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const Route53RecordSetResourceType: ResourceTypeDefinition = {
  id: "route53-record-set",
  displayName: "Route 53 Record",
  pluralDisplayName: "Route 53 Records",
  description: "A DNS record in an Amazon Route 53 hosted zone",
  parentTypeId: "route53-hosted-zone",
  fields: [
    { key: "name", label: "Record Name", kind: "string", required: true },
    {
      key: "type",
      label: "Record Type",
      kind: "enum",
      required: true,
      enumValues: ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV", "SOA", "PTR", "CAA", "ALIAS"],
    },
    { key: "ttl", label: "TTL", kind: "number", required: false },
    { key: "values", label: "Values", kind: "string", required: false },
    { key: "hostedZoneId", label: "Hosted Zone ID", kind: "string", required: true },
  ],
  outputs: [],
  dashboardPinnable: false,
  iconKey: "dns",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "aws", resourceTypeId: "alb", verb: "Point alias" },
    { pluginId: "aws", resourceTypeId: "cloudfront-distribution", verb: "Point alias" },
  ],
};
