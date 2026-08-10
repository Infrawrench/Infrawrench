import { f, o, rt } from "@infrawrench/plugin-base";

export const EKSClusterResourceType = rt({
  name: "EKS Cluster",
  id: "eks-cluster",
  description:
    "An Amazon Elastic Kubernetes Service cluster. Creating one also provisions a default " +
    "managed node group once the control plane is ACTIVE (~10-15 min) — node counts show 0 " +
    "until then.",
  fields: [
    f("name", "Name"),
    f("version", "Kubernetes Version"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["CREATING", "ACTIVE", "DELETING", "FAILED", "UPDATING", "PENDING"],
    }),
    f("platformVersion", "Platform Version", { required: false }),
    f("roleArn", "Role ARN", { required: false }),
    f("nodeGroupCount", "Node Groups", { kind: "number", required: false }),
    f("nodeCount", "Node Count", { kind: "number", required: false }),
    f("instanceTypes", "Instance Types", {
      required: false,
      description: "Instance types used across managed node groups",
    }),
    f("diskSizeGb", "Disk Size (GB)", {
      kind: "number",
      required: false,
      description: "Disk size of the first node group",
    }),
    f("vpcId", "VPC ID", { required: false }),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs the control plane ENIs live in",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated additional security group IDs on the control plane ENIs",
    }),
    f("clusterSecurityGroupId", "Cluster Security Group", {
      required: false,
      description: "EKS-managed security group shared by the control plane and managed nodes",
    }),
  ],
  outputs: [
    o("endpoint", "API Endpoint", {
      hidden: true,
      description: "HTTPS endpoint for the Kubernetes API server",
    }),
    o("certificateAuthority", "Certificate Authority", {
      hidden: true,
      description: "Base64-encoded CA data for cluster TLS verification",
    }),
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Generated kubeconfig YAML for kubectl access",
    }),
  ],
  // The cluster stores the service role as a full ARN while an IAM role's
  // external id is the bare role name, so match the role's `roleArn` output.
  dependsOn: [
    { fieldKey: "roleArn", targetTypeId: "iam-role", targetKey: "roleArn", label: "runs as" },
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
    { fieldKey: "clusterSecurityGroupId", targetTypeId: "security-group", label: "guarded by" },
  ],
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
});
