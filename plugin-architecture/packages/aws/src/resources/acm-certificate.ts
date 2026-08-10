import { f, o, rt } from "@infrawrench/plugin-base";

export const ACMCertificateResourceType = rt({
  name: "ACM Certificate",
  id: "acm-certificate",
  description: "An AWS Certificate Manager SSL/TLS certificate",
  fields: [
    f("domainName", "Domain Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "PENDING_VALIDATION",
        "ISSUED",
        "INACTIVE",
        "REVOKED",
        "EXPIRED",
        "VALIDATION_TIMED_OUT",
        "FAILED",
      ],
    }),
    f("type", "Type", {
      kind: "enum",
      required: false,
      enumValues: ["IMPORTED", "AMAZON_ISSUED", "PRIVATE"],
    }),
    f("issuer", "Issuer", { required: false }),
    f("notBefore", "Valid From", { required: false }),
    f("notAfter", "Valid Until", { required: false }),
    f("keyAlgorithm", "Key Algorithm", { required: false }),
    f("subjectAlternativeNames", "SANs", { required: false }),
    f("inUseBy", "In Use By", { kind: "number", required: false }),
    f("inUseByArns", "In Use By (ARNs)", {
      required: false,
      description: "Comma-separated ARNs of the resources the certificate is installed on",
    }),
  ],
  outputs: [
    o("certificateArn", "Certificate ARN"),
    o("dnsRecords", "DNS Validation Records"),
    o("domainValidationStatus", "Domain Validation Status"),
  ],
  // `InUseBy` holds ARNs; neither an ALB nor a distribution is keyed by ARN, so
  // match each type's ARN output.
  dependsOn: [
    {
      fieldKey: "inUseByArns",
      targetTypeId: "alb",
      targetKey: "loadBalancerArn",
      label: "used by",
    },
    {
      fieldKey: "inUseByArns",
      targetTypeId: "cloudfront-distribution",
      targetKey: "distributionArn",
      label: "used by",
    },
  ],
  // The lister stores DescribeCertificate's NotAfter (epoch seconds, stringified).
  expiryFields: [
    { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  iconKey: "certificate",
  supportsCreate: true,
});
