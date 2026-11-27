import { f, o, rt } from "@infrawrench/plugin-base";
import { EKS_EXTENDED_SUPPORT } from "../extended-support.js";

export const EKSClusterResourceType = rt({
  name: "EKS Cluster",
  id: "eks-cluster",
  // Nodes are EC2 instances in their own right, so the cluster is shown on its
  // page and in the create form but never added to the total twice.
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      sizeFieldKey: "instanceTypes",
      catalogueFieldKey: "instanceType",
      list: true,
    },
    countFieldKey: "nodeCount",
  },
  description:
    "An Amazon Elastic Kubernetes Service cluster. Creating one also provisions a default " +
    "managed node group once the control plane is ACTIVE (~10-15 min). Node counts show 0 " +
    "until then.",
  // EKS has no node group type here: the cluster carries its managed node
  // groups' instance types, total node count and first group's disk.
  equivalence: "kubernetes-cluster",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false, editable: false, sizing: "region" }),
    f("version", "Kubernetes Version", { showcase: true }),
    f("status", "Status", {
      showcase: true,
      kind: "enum",
      enumValues: ["CREATING", "ACTIVE", "DELETING", "FAILED", "UPDATING", "PENDING"],
    }),
    f("platformVersion", "Platform Version", { required: false }),
    f("supportType", "Upgrade Policy", {
      required: false,
      description:
        "EXTENDED keeps the version on paid extended support after standard support ends; STANDARD upgrades it automatically",
    }),
    f("roleArn", "Role ARN", { required: false }),
    f("nodeGroupCount", "Node Groups", { kind: "number", required: false }),
    f("nodeCount", "Node Count", {
      showcase: true,
      kind: "number",
      required: false,
      sizing: "node-count",
      usage: { limit: { field: "maxNodeCount" }, unit: "nodes", label: "Node Group Capacity" },
    }),
    f("maxNodeCount", "Max Nodes", {
      kind: "number",
      required: false,
      editable: false,
      description: "Sum of every managed node group's maximum size",
    }),
    f("controlPlaneTier", "Control Plane Tier", {
      required: false,
      editable: false,
      description: "standard, or the Provisioned Control Plane scaling tier",
    }),
    // The stored spelling; the create form calls it `instanceType`, and the
    // estimator accepts both.
    f("instanceTypes", "Instance Types", {
      required: false,
      sizing: "instance-type",
      description: "Instance types used across managed node groups",
    }),
    f("diskSizeGb", "Disk Size (GB)", {
      showcase: true,
      kind: "number",
      required: false,
      sizing: "disk-gb",
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
    o("nodeHourlyRates", "Node Hourly Rates", {
      hidden: true,
      description:
        "JSON map of node instance type to hourly price, handed to the Kubernetes peer so it can derive per-namespace and per-workload cost. Empty when no price is available.",
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
  extendedSupport: EKS_EXTENDED_SUPPORT,
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsMetrics: true,
  // `eksClusterMetrics` charts `etcd_mvcc_db_total_size_in_bytes` (the etcd
  // database file, which the size limit is enforced on) as "etcd Size
  // Allocated". Standard mode holds 8 GB; the Provisioned Control Plane
  // tiers 16 GB (24 GB for 4XL and 8XL on Kubernetes 1.34 and later, so 16
  // is the earlier of the two there):
  // https://docs.aws.amazon.com/eks/latest/userguide/eks-provisioned-control-plane.html
  // (read 2026-11-23). etcd counts these in GiB.
  capacityMetrics: [
    {
      seriesLabel: "etcd Size Allocated",
      limit: {
        plan: {
          field: "controlPlaneTier",
          allowances: {
            standard: 8 * 1024 ** 3,
            "tier-xl": 16 * 1024 ** 3,
            "tier-2xl": 16 * 1024 ** 3,
            "tier-4xl": 16 * 1024 ** 3,
            "tier-8xl": 16 * 1024 ** 3,
          },
        },
      },
      unit: "bytes",
      label: "etcd Database",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
        // What this cluster's nodes cost per hour. The kubernetes plugin has
        // no way to know (the money is on THIS account) so it arrives the
        // same way the kubeconfig does. Resolves to "" when we have no price,
        // which the peer reads as "show capacity without money".
        { outputKey: "nodeHourlyRates", credentialKey: "nodeHourlyRates" },
      ],
      tabLabel: "Kubernetes",
      // Merge the peer's derived cost/efficiency series into THIS resource's
      // own Metrics tab, so cluster spend sits next to the provider's node
      // metrics instead of being buried one tab deeper.
      exposeMetricsToParent: true,
      ci: {
        lends:
          "A kubeconfig with an EKS token: a GetCallerIdentity request presigned with the AWS connection's access key, which the cluster reads as that IAM user.",
        reach:
          "Only this cluster: EKS turns the token into the IAM user's identity there, and it can do what the cluster's access entries or aws-auth map that user to. It is not an AWS credential.",
        lifetime:
          "Fifteen minutes from when the run starts, which EKS enforces. A job that starts later, behind others it needs, is refused by the cluster.",
      },
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
