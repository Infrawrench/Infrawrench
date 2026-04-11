import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudFrontDistributionResourceType: ResourceTypeDefinition = {
  id: "cloudfront-distribution",
  displayName: "CloudFront Distribution",
  pluralDisplayName: "CloudFront Distributions",
  description: "An Amazon CloudFront CDN distribution",
  fields: [
    { key: "distributionId", label: "Distribution ID", kind: "string", required: true },
    { key: "domainName", label: "Domain Name", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
    { key: "comment", label: "Comment", kind: "string", required: false },
    { key: "priceClass", label: "Price Class", kind: "string", required: false },
    { key: "httpVersion", label: "HTTP Version", kind: "string", required: false },
  ],
  outputs: [{ key: "distributionArn", label: "Distribution ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "cdn",
};
