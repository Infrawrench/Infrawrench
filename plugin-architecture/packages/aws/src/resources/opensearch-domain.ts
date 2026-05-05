import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const OpenSearchDomainResourceType: ResourceTypeDefinition = {
  id: "opensearch-domain",
  displayName: "OpenSearch Domain",
  pluralDisplayName: "OpenSearch Domains",
  description: "An Amazon OpenSearch Service domain",
  fields: [
    { key: "domainName", label: "Domain Name", kind: "string", required: true },
    { key: "engineVersion", label: "Engine Version", kind: "string", required: true },
    { key: "instanceType", label: "Instance Type", kind: "string", required: false },
    { key: "instanceCount", label: "Instance Count", kind: "number", required: false },
    { key: "status", label: "Processing", kind: "boolean", required: false },
    { key: "volumeType", label: "Volume Type", kind: "string", required: false },
    { key: "volumeSize", label: "Volume Size (GB)", kind: "number", required: false },
    { key: "encryptionEnabled", label: "Encryption", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint", sensitive: false },
    { key: "dashboardEndpoint", label: "Dashboard Endpoint", sensitive: false },
    { key: "domainArn", label: "Domain ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "search",
  supportsCreate: true,
  secretExportTemplates: [
    {
      id: "opensearch-endpoint",
      displayName: "OpenSearch Endpoint",
      description: "OpenSearch domain endpoint for connecting",
      entries: [
        { envKey: "OPENSEARCH_ENDPOINT", outputKey: "endpoint" },
        { envKey: "OPENSEARCH_DASHBOARD", outputKey: "dashboardEndpoint" },
      ],
    },
  ],
};
