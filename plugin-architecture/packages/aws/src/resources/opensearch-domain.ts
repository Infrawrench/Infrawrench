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
  supportsMetrics: true,
  peerIntegrations: [
    {
      // Forwards the domain endpoint to the OpenSearch plugin. Auth is set
      // by the user in the OpenSearch tab credentials — typically AWS
      // SigV4 (service "es") for IAM-only domains, or basic auth when
      // fine-grained access control is enabled with an internal user
      // database. The OpenSearch plugin's `authMode` credential picks
      // which scheme to use.
      pluginId: "opensearch",
      credentialMappings: [{ outputKey: "endpoint", credentialKey: "endpoint" }],
      tabLabel: "OpenSearch",
    },
  ],
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
