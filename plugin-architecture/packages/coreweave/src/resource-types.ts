import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { KUBERNETES_VERSIONS } from "./catalog.js";

/**
 * CoreWeave resource types. Each names the API it lists from; field names
 * follow the published OpenAPI documents for the CKS, VPC and AI Object
 * Storage APIs and the Node Pool CRD reference (docs.coreweave.com, 2026-10).
 */

/**
 * The organization the API token belongs to. Not an API object: CoreWeave
 * tokens are organization-scoped and there is no organization endpoint, so
 * this one row carries the account-wide usage and estimated spend read from
 * the FOCUS export.
 */
export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The CoreWeave organization the API token belongs to. Month-to-date GPU-hours and estimated spend by instance type, cluster and capacity plan, from the FOCUS usage export.",
  fields: [
    f("name", "Name", { editable: false }),
    f("gpuHoursMtd", "GPU-Hours This Month", { kind: "number", required: false, editable: false }),
    f("estimatedMtd", "Estimated Spend This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("pricing", "Pricing", { required: false, editable: false }),
    f("usageExport", "Usage Export", { required: false, editable: false }),
  ],
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /v1beta1/cks/clusters`. */
export const ClusterResourceType = rt({
  name: "CKS Cluster",
  id: "cks-cluster",
  description:
    "A CoreWeave Kubernetes Service cluster. Create one in a VPC, change its Kubernetes version and API server visibility, and see workloads, per-namespace GPU cost and GPU utilization.",
  fields: [
    f("name", "Name", { editable: false }),
    f("zone", "Zone", { editable: false }),
    f("version", "Kubernetes Version", {
      kind: "enum",
      enumValues: KUBERNETES_VERSIONS,
      description:
        "Minor version; CKS applies patch releases itself. Upgrades go one minor version at a time.",
    }),
    f("public", "Public API Server", {
      kind: "boolean",
      required: false,
      description: "Whether the Kubernetes API server is reachable from the Internet.",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("vpcName", "VPC Name", { required: false, editable: false }),
    f("apiServerEndpoint", "API Server Endpoint", { required: false, editable: false }),
    f("publicEndpoint", "Public Endpoint", { required: false, editable: false }),
    f("podCidrName", "Pod CIDR Prefix", { required: false, editable: false }),
    f("serviceCidrName", "Service CIDR Prefix", { required: false, editable: false }),
    f("internalLbCidrNames", "Internal Load Balancer Prefixes", {
      required: false,
      editable: false,
    }),
    f("upgradeable", "Self-Serve Upgrade Available", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("nodePoolCount", "Node Pools", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("gpuCount", "GPUs", { kind: "number", required: false, editable: false }),
    f("hourlyRunRate", "Estimated Run Rate (USD/hour)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description:
        "Kubeconfig for this cluster, authenticated with the account's API access token.",
    }),
    o("apiServerEndpoint", "API Server Endpoint"),
    o("clusterId", "Cluster ID"),
    o("nodeHourlyRates", "Node Hourly Rates", {
      hidden: true,
      description:
        "JSON map of instance type to hourly price, handed to the Kubernetes peer so it can derive per-namespace and per-workload cost.",
    }),
  ],
  dependsOn: [{ fieldKey: "vpcId", targetTypeId: "vpc", label: "runs in" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "kubernetes",
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
        { outputKey: "nodeHourlyRates", credentialKey: "nodeHourlyRates" },
      ],
      tabLabel: "Kubernetes",
      exposeMetricsToParent: true,
      unreachableWhen: {
        fieldsEmpty: ["publicEndpoint"],
        title: "This cluster's Kubernetes API server is not reachable from the Internet.",
        suggestions: [
          "Turn on Public API Server in Edit to reach it from Infrawrench.",
          "Or attach a bastion in the cluster's VPC to this account, or reach it over the cluster's Tailscale proxy.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "cks-kubeconfig",
      displayName: "CKS Kubeconfig",
      description: "Kubeconfig for kubectl access to this CKS cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "apiServerEndpoint" },
      ],
    },
  ],
});

/** `NodePool` (`compute.coreweave.com/v1alpha1`, cluster-scoped) in each cluster. */
export const NodePoolResourceType = rt({
  name: "Node Pool",
  id: "node-pool",
  description:
    "A CKS Node Pool: a set of Nodes of one instance type. Create, scale (rack sizing and autoscaler bounds are checked first), scale to zero and back, and chart GPU utilization.",
  parentTypeId: "cks-cluster",
  showInSidebar: true,
  fields: [
    f("name", "Name", { editable: false }),
    f("clusterName", "Cluster", { required: false, editable: false }),
    f("instanceType", "Instance Type", { editable: false }),
    f("gpuModel", "GPU", { required: false, editable: false }),
    f("computeClass", "Compute Class", { required: false, editable: false }),
    f("targetNodes", "Target Nodes", {
      kind: "number",
      required: false,
      description:
        "How many Nodes the pool should have. Rack-scale (NVL72) instance types take a multiple of 18. With autoscaling on, this must sit between the minimum and maximum.",
    }),
    f("autoscaling", "Autoscaling", {
      kind: "boolean",
      required: false,
      description: "Let the cluster autoscaler move Target Nodes between the bounds below.",
    }),
    f("minNodes", "Autoscaler Minimum", { kind: "number", required: false }),
    f("maxNodes", "Autoscaler Maximum", { kind: "number", required: false }),
    f("scaleDownStrategy", "Scale-Down Strategy", {
      kind: "enum",
      required: false,
      enumValues: ["IdleOnly", "PreferIdle"],
      description:
        "IdleOnly removes only idle Nodes when scaling down; PreferIdle removes idle Nodes first and then busy ones.",
    }),
    f("currentNodes", "Current Nodes", { kind: "number", required: false, editable: false }),
    f("queuedNodes", "Queued Nodes", { kind: "number", required: false, editable: false }),
    f("inProgressNodes", "Booting Nodes", { kind: "number", required: false, editable: false }),
    f("gpuCount", "GPUs", { kind: "number", required: false, editable: false }),
    f("hourlyRate", "Instance Price (USD/hour)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("hourlyRunRate", "Estimated Run Rate (USD/hour)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("state", "State", {
      required: false,
      editable: false,
      description: "running, or scaled-to-zero after Scale to zero.",
    }),
    f("ready", "Ready", { required: false, editable: false }),
    f("nodeProfile", "Node Configuration", { required: false, editable: false }),
    f("pendingConfiguration", "Pending Configuration", { required: false, editable: false }),
    f("gpuDriver", "GPU Driver", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("nodePoolName", "Node Pool Name")],
  dependsOn: [{ fieldKey: "instanceType", targetTypeId: "instance-type", label: "runs" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "server",
  lifecycle: {
    startActionId: "restore",
    stopActionId: "scale-to-zero",
    statusFieldKey: "state",
    runningValues: ["running"],
    stoppedValues: ["scaled-to-zero"],
  },
});

/** Static catalog: CoreWeave has no instance-type or pricing API. */
export const InstanceTypeResourceType = rt({
  name: "Instance Type",
  id: "instance-type",
  description:
    "A CoreWeave GPU or CPU instance type with its hardware, the zones it is offered in and its published on-demand price (or your negotiated rate), per instance-hour and per GPU-hour.",
  pinnable: false,
  fields: [
    f("name", "Name", { editable: false }),
    f("family", "Family", { editable: false }),
    f("gpuModel", "GPU", { required: false, editable: false }),
    f("gpuCount", "GPUs", { kind: "number", required: false, editable: false }),
    f("gpuMemoryGb", "Memory per GPU (GB)", { kind: "number", required: false, editable: false }),
    f("cpuModel", "CPU", { required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("ramGb", "RAM (GB)", { kind: "number", required: false, editable: false }),
    f("storageTb", "Local Storage (TB)", { kind: "number", required: false, editable: false }),
    f("hourlyUsd", "Price (USD/instance-hour)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("gpuHourlyUsd", "Price (USD/GPU-hour)", { kind: "number", required: false, editable: false }),
    f("monthlyUsd", "Price (USD/month, 730 hours)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("priceSource", "Price Source", { required: false, editable: false }),
    f("rackScale", "Rack-Scale (NVL72)", { kind: "boolean", required: false, editable: false }),
    f("zones", "Zones", { required: false, editable: false }),
    f("inUseNodes", "Nodes in Use", { kind: "number", required: false, editable: false }),
  ],
  iconKey: "cpu",
});

/** `GET /v1beta1/networking/vpcs`. */
export const VpcResourceType = rt({
  name: "VPC",
  plural: "VPCs",
  id: "vpc",
  description:
    "A CoreWeave Virtual Private Cloud. CKS clusters take their pod, service and internal load balancer ranges from its named prefixes. Add prefixes and toggle public ingress and egress.",
  fields: [
    f("name", "Name", { editable: false }),
    f("zone", "Zone", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("prefixes", "VPC Prefixes", {
      required: false,
      description:
        "Named prefixes as name=CIDR, comma separated, for example pod cidr=10.0.0.0/13, service cidr=10.16.0.0/22. Prefixes can be added; removing one a cluster uses fails.",
    }),
    f("hostPrefixes", "Host Prefixes", { required: false, editable: false }),
    f("disablePublicServices", "Block Public Ingress", { kind: "boolean", required: false }),
    f("disablePublicAccess", "Block Internet Egress", { kind: "boolean", required: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("vpcId", "VPC ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "network",
});

/** `GET /v1/cwobject/bucket-info`. */
export const BucketResourceType = rt({
  name: "Object Storage Bucket",
  id: "bucket",
  description:
    "A CoreWeave AI Object Storage bucket. Browse, upload and delete objects, see its size and estimated monthly cost, and change audit logging, archiving and its capacity cap.",
  fields: [
    f("name", "Name", { editable: false }),
    f("zone", "Zone", { editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("size", "Size", { required: false, editable: false }),
    f("estimatedMonthlyUsd", "Estimated Monthly Cost (USD, hot tier)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("auditLogging", "Audit Logging", { kind: "boolean", required: false }),
    f("archiveEnabled", "Archive Idle Objects", {
      kind: "boolean",
      required: false,
      description:
        "Move objects nobody has read for a while to the cheaper infrequent-access class. Your organization must be entitled to it.",
    }),
    f("archiveAfterDays", "Archive After (days without access)", {
      kind: "number",
      required: false,
      description: "Required when archiving is on.",
    }),
    f("capacityCapGb", "Capacity Cap (GB)", {
      kind: "number",
      required: false,
      description:
        "Refuse writes once the bucket holds this much. Leave empty for no cap. Your organization must be entitled to it.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("bucketName", "Bucket Name"), o("endpoint", "S3 Endpoint"), o("region", "S3 Region")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsStorageBrowser: true,
  iconKey: "bucket",
});

/** `GET /v1/cwobject/access-key`. Secrets are never returned. */
export const AccessKeyResourceType = rt({
  name: "Object Storage Access Key",
  id: "access-key",
  description:
    "An AI Object Storage access key: who owns it, whether it is active and when it expires. Suspend or reactivate every key a principal owns.",
  pinnable: false,
  fields: [
    f("accessKeyId", "Access Key ID", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("principal", "Owner", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "access-key", label: "Access key expiry" },
  ],
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ClusterResourceType,
  NodePoolResourceType,
  InstanceTypeResourceType,
  VpcResourceType,
  BucketResourceType,
  AccessKeyResourceType,
];
