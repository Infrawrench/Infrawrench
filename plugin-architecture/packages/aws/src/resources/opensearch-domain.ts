import { f, o, rt } from "@infrawrench/plugin-base";

export const OpenSearchDomainResourceType = rt({
  name: "OpenSearch Domain",
  id: "opensearch-domain",
  description: "An Amazon OpenSearch Service domain",
  fields: [
    f("domainName", "Domain Name"),
    f("engineVersion", "Engine Version"),
    f("instanceType", "Instance Type", { required: false }),
    f("instanceCount", "Instance Count", { kind: "number", required: false }),
    f("status", "Processing", { kind: "boolean", required: false }),
    f("volumeType", "Volume Type", { required: false }),
    f("volumeSize", "Volume Size (GB)", { kind: "number", required: false }),
    f("encryptionEnabled", "Encryption", { kind: "boolean", required: false }),
    f("vpcId", "VPC ID", { required: false, description: "Set on VPC-attached domains only" }),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs the domain's ENIs live in",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated security group IDs applied to the domain's ENIs",
    }),
  ],
  outputs: [
    o("endpoint", "Endpoint"),
    o("dashboardEndpoint", "Dashboard Endpoint"),
    o("domainArn", "Domain ARN"),
  ],
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
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
});
