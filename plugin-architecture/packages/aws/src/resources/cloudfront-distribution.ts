import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudFrontDistributionResourceType = rt({
  name: "CloudFront Distribution",
  id: "cloudfront-distribution",
  description: "An Amazon CloudFront CDN distribution",
  fields: [
    f("distributionId", "Distribution ID"),
    f("domainName", "Domain Name"),
    f("status", "Status"),
    f("enabled", "Enabled", { kind: "boolean" }),
    f("comment", "Comment", { required: false }),
    f("priceClass", "Price Class", { required: false }),
    f("httpVersion", "HTTP Version", { required: false }),
  ],
  outputs: [o("distributionArn", "Distribution ARN")],
  iconKey: "cdn",
  supportsMetrics: true,
});
