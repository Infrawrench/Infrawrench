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
    f("originDomains", "Origins", {
      required: false,
      description: "Comma-separated origin domain names configured on the distribution",
    }),
    f("originBucketNames", "Origin Buckets", {
      required: false,
      description: "Bucket names peeled off the S3 origin domains",
    }),
  ],
  outputs: [o("distributionArn", "Distribution ARN")],
  // An origin domain is a load balancer's DNS name or an S3 bucket's REST
  // endpoint — the bucket name is extracted from the latter by the lister.
  dependsOn: [
    { fieldKey: "originDomains", targetTypeId: "alb", targetKey: "dnsName", label: "origin" },
    { fieldKey: "originBucketNames", targetTypeId: "s3-bucket", label: "origin" },
  ],
  iconKey: "cdn",
  supportsMetrics: true,
});
