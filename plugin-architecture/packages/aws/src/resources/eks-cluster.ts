import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const EKSClusterResourceType: ResourceTypeDefinition = {
  id: "eks-cluster",
  displayName: "EKS Cluster",
  pluralDisplayName: "EKS Clusters",
  description: "An Amazon Elastic Kubernetes Service cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "version", label: "Kubernetes Version", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: ["CREATING", "ACTIVE", "DELETING", "FAILED", "UPDATING", "PENDING"],
    },
    { key: "platformVersion", label: "Platform Version", kind: "string", required: false },
    { key: "roleArn", label: "Role ARN", kind: "string", required: false },
  ],
  outputs: [
    {
      key: "endpoint",
      label: "API Endpoint",
      sensitive: false,
      description: "HTTPS endpoint for the Kubernetes API server",
    },
    {
      key: "certificateAuthority",
      label: "Certificate Authority",
      sensitive: false,
      description: "Base64-encoded CA data for cluster TLS verification",
    },
  ],
  dashboardPinnable: true,
  iconKey: "kubernetes",
  supportsCreate: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
      ],
      tabLabel: "Workloads",
    },
  ],
};
