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
    { key: "nodeGroupCount", label: "Node Groups", kind: "number", required: false },
    { key: "nodeCount", label: "Node Count", kind: "number", required: false },
    {
      key: "instanceTypes",
      label: "Instance Types",
      kind: "string",
      required: false,
      description: "Instance types used across managed node groups",
    },
    {
      key: "diskSizeGb",
      label: "Disk Size (GB)",
      kind: "number",
      required: false,
      description: "Disk size of the first node group",
    },
  ],
  outputs: [
    {
      key: "endpoint",
      label: "API Endpoint",
      sensitive: false,
      hidden: true,
      description: "HTTPS endpoint for the Kubernetes API server",
    },
    {
      key: "certificateAuthority",
      label: "Certificate Authority",
      sensitive: false,
      hidden: true,
      description: "Base64-encoded CA data for cluster TLS verification",
    },
    {
      key: "kubeconfig",
      label: "Kubeconfig",
      sensitive: true,
      hidden: true,
      description: "Generated kubeconfig YAML for kubectl access",
    },
  ],
  dashboardPinnable: true,
  iconKey: "kubernetes",
  supportsCreate: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
    },
  ],
  secretExportTemplates: [
    {
      id: "eks-kubeconfig",
      displayName: "EKS Kubeconfig",
      description: "Kubeconfig for connecting to this EKS cluster",
      entries: [
        {
          envKey: "KUBECONFIG_DATA",
          outputKey: "kubeconfig",
          description: "Generated kubeconfig YAML",
        },
        {
          envKey: "KUBE_API_ENDPOINT",
          outputKey: "endpoint",
          description: "Kubernetes API endpoint",
        },
      ],
    },
  ],
};
