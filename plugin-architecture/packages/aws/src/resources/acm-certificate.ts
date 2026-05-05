import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ACMCertificateResourceType: ResourceTypeDefinition = {
  id: "acm-certificate",
  displayName: "ACM Certificate",
  pluralDisplayName: "ACM Certificates",
  description: "An AWS Certificate Manager SSL/TLS certificate",
  fields: [
    { key: "domainName", label: "Domain Name", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: [
        "PENDING_VALIDATION",
        "ISSUED",
        "INACTIVE",
        "REVOKED",
        "EXPIRED",
        "VALIDATION_TIMED_OUT",
        "FAILED",
      ],
    },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: false,
      enumValues: ["IMPORTED", "AMAZON_ISSUED", "PRIVATE"],
    },
    { key: "issuer", label: "Issuer", kind: "string", required: false },
    { key: "notBefore", label: "Valid From", kind: "string", required: false },
    { key: "notAfter", label: "Valid Until", kind: "string", required: false },
    { key: "keyAlgorithm", label: "Key Algorithm", kind: "string", required: false },
    { key: "subjectAlternativeNames", label: "SANs", kind: "string", required: false },
    { key: "inUseBy", label: "In Use By", kind: "number", required: false },
  ],
  outputs: [
    { key: "certificateArn", label: "Certificate ARN", sensitive: false },
    { key: "dnsRecords", label: "DNS Validation Records", sensitive: false },
    { key: "domainValidationStatus", label: "Domain Validation Status", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "certificate",
  supportsCreate: true,
};
