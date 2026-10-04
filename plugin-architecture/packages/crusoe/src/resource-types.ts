import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Every project-scoped resource's externalId is `<projectId>/<id>`, because
 * the API addresses them under `/projects/{project_id}/...` and a bare id
 * cannot be turned back into a URL. Projects and SSH keys (user-scoped) use
 * the bare id; reservations use `<organizationId>/<id>`.
 */

/** Normalised VM states (the raw `STATE_*` value is kept in `rawState`). */
export const VM_STATES = [
  "running",
  "stopped",
  "provisioning",
  "degraded",
  "paused",
  "crashed",
  "unknown",
] as const;

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A Crusoe Cloud project: the container VMs, disks, networks and clusters live in",
  fields: [
    f("name", "Name"),
    f("organizationName", "Organization", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("vmCount", "VMs", { kind: "number", required: false, editable: false }),
    f("diskCount", "Disks", { kind: "number", required: false, editable: false }),
    f("networkCount", "VPC Networks", { kind: "number", required: false, editable: false }),
  ],
  iconKey: "folder",
  supportsCreate: true,
  // Edit = rename (the only field Crusoe's PUT accepts).
  supportsUpdate: true,
});

export const VmResourceType = rt({
  name: "VM",
  plural: "VMs",
  id: "vm",
  description: "A Crusoe Cloud virtual machine (GPU or CPU)",
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", { kind: "enum", enumValues: [...VM_STATES], editable: false }),
    f("type", "Instance Type", {
      description:
        "Crusoe product name, e.g. h100-80gb-sxm-ib.8x or c1a.8x. Changing it resizes the VM; Crusoe requires the VM to be stopped first",
    }),
    f("location", "Location", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("billingType", "Billing", {
      required: false,
      editable: false,
      description: "On-demand, Spot, or PoC",
    }),
    f("reservationId", "Reservation", { required: false, editable: false }),
    f("gpuType", "GPU", { required: false, editable: false }),
    f("gpuCount", "GPUs", { kind: "number", required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("diskIds", "Disks", {
      required: false,
      editable: false,
      description: "Comma-separated IDs of the disks attached to this VM",
    }),
    f("subnetId", "Subnet", { required: false, editable: false }),
    f("networkId", "VPC Network", { required: false, editable: false }),
    f("publicIpType", "Public IP Type", { required: false, editable: false }),
    f("rawState", "Provider State", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("publicIp", "Public IPv4"),
    o("privateIp", "Private IPv4"),
    o("dnsName", "External DNS Name"),
  ],
  dependsOn: [
    {
      fieldKey: "subnetId",
      matchTemplate: "{projectId}/{subnetId}",
      targetTypeId: "vpc-subnet",
      label: "in subnet",
    },
    {
      fieldKey: "networkId",
      matchTemplate: "{projectId}/{networkId}",
      targetTypeId: "vpc-network",
      label: "in VPC",
    },
    {
      fieldKey: "diskIds",
      matchTemplate: "{projectId}/{diskIds}",
      targetTypeId: "disk",
      label: "uses disk",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "server",
  supportsCreate: true,
  // Edit = change instance type (PATCH action UPDATE). Name is immutable.
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "state", value: "running" },
    // Crusoe's images are Ubuntu; the docs connect as `ubuntu@<ip>`.
    defaultUsername: "ubuntu",
  },
  // A stopped VM stops billing for compute, but its disks keep billing for
  // storage, and a stopped VM is usually one somebody forgot.
  orphanRule: {
    conditions: [{ fieldKey: "state", when: "equals", value: "stopped" }],
    reason:
      "VM is stopped. Crusoe does not bill compute for a stopped VM, but its attached disks keep billing for storage until they are deleted.",
  },
});

export const DiskResourceType = rt({
  name: "Disk",
  id: "disk",
  description: "A Crusoe persistent SSD or shared volume",
  fields: [
    f("name", "Name", { editable: false }),
    f("sizeGib", "Size (GiB)", {
      kind: "number",
      description: "Disk capacity. Crusoe can only grow a disk, never shrink it",
    }),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["persistent-ssd", "shared-volume"],
      editable: false,
    }),
    f("location", "Location", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("attachedVmIds", "Attached VMs", {
      required: false,
      editable: false,
      description: "Comma-separated IDs of the VMs this disk is attached to; empty when detached",
    }),
    f("attachmentType", "Attachment", {
      required: false,
      editable: false,
      description: "os (boot disk) or data",
    }),
    f("blockSize", "Block Size (bytes)", { kind: "number", required: false, editable: false }),
    f("serialNumber", "Serial Number", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("dnsName", "Mount DNS Name", { description: "Shared volumes only" })],
  dependsOn: [
    {
      fieldKey: "attachedVmIds",
      matchTemplate: "{projectId}/{attachedVmIds}",
      targetTypeId: "vm",
      label: "attached to",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "volume",
  supportsCreate: true,
  // Edit = grow the disk (PATCH size).
  supportsUpdate: true,
  // The lister always writes attachedVmIds ("" when detached), so `equals ""`
  // never flags a row synced before the field existed.
  orphanRule: {
    conditions: [{ fieldKey: "attachedVmIds", when: "equals", value: "" }],
    reason: "Disk is not attached to any VM but is still billed for its full capacity",
  },
  attachTargets: [
    { pluginId: "crusoe", resourceTypeId: "vm", matchField: "location", verb: "Attach" },
  ],
});

export const SnapshotResourceType = rt({
  name: "Disk Snapshot",
  id: "snapshot",
  description: "A point-in-time snapshot of a Crusoe disk",
  fields: [
    f("name", "Name"),
    f("sizeGib", "Size (GiB)", { kind: "number", required: false }),
    f("sourceDiskId", "Source Disk", { required: false }),
    f("projectId", "Project"),
    f("createdAt", "Created", { required: false }),
  ],
  dependsOn: [
    {
      fieldKey: "sourceDiskId",
      matchTemplate: "{projectId}/{sourceDiskId}",
      targetTypeId: "disk",
      label: "snapshot of",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "image",
  supportsCreate: true,
});

export const VpcNetworkResourceType = rt({
  name: "VPC Network",
  id: "vpc-network",
  description: "A Crusoe VPC network",
  fields: [
    f("name", "Name"),
    f("cidr", "CIDR", { editable: false }),
    f("subnetIds", "Subnets", { required: false, editable: false }),
    f("gatewayId", "Gateway", { required: false, editable: false }),
    f("projectId", "Project", { editable: false }),
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const VpcSubnetResourceType = rt({
  name: "VPC Subnet",
  id: "vpc-subnet",
  description: "A subnet of a Crusoe VPC network in one location",
  fields: [
    f("name", "Name"),
    f("cidr", "CIDR", { editable: false }),
    f("location", "Location", { editable: false }),
    f("networkId", "VPC Network", { editable: false }),
    f("natGateway", "NAT Gateway", {
      kind: "boolean",
      required: false,
      description: "Give VMs without a public IP outbound internet access through a NAT gateway",
    }),
    f("natPublicIp", "NAT Public IP", { required: false, editable: false }),
    f("projectId", "Project", { editable: false }),
  ],
  dependsOn: [
    {
      fieldKey: "networkId",
      matchTemplate: "{projectId}/{networkId}",
      targetTypeId: "vpc-network",
      label: "in VPC",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const FirewallRuleResourceType = rt({
  name: "Firewall Rule",
  id: "firewall-rule",
  description: "A VPC firewall rule",
  fields: [
    f("name", "Name"),
    f("networkId", "VPC Network", { editable: false }),
    f("direction", "Direction", {
      kind: "enum",
      enumValues: ["ingress", "egress"],
      editable: false,
    }),
    f("action", "Action", { kind: "enum", enumValues: ["allow", "deny"], editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("protocols", "Protocols", {
      description: "Comma-separated, e.g. tcp,udp,icmp",
    }),
    f("sources", "Sources", {
      description: "Comma-separated CIDR blocks or VPC network, subnet or VM IDs",
    }),
    f("sourcePorts", "Source Ports", {
      required: false,
      description: "Comma-separated ports or ranges, e.g. 1-65535",
    }),
    f("destinations", "Destinations", {
      description: "Comma-separated CIDR blocks or VPC network, subnet or VM IDs",
    }),
    f("destinationPorts", "Destination Ports", {
      required: false,
      description: "Comma-separated ports or ranges, e.g. 22,443,3000-8080",
    }),
    f("projectId", "Project", { editable: false }),
  ],
  dependsOn: [
    {
      fieldKey: "networkId",
      matchTemplate: "{projectId}/{networkId}",
      targetTypeId: "vpc-network",
      label: "applies to",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "firewall",
  supportsCreate: true,
  supportsUpdate: true,
  postureChecks: [
    {
      id: "crusoe-firewall-open-to-internet",
      title: "Ingress open to the internet",
      severity: "medium",
      category: "public-exposure",
      conditions: [
        { fieldKey: "direction", when: "equals", value: "ingress" },
        { fieldKey: "action", when: "equals", value: "allow" },
        { fieldKey: "sources", when: "equals", value: "0.0.0.0/0" },
      ],
      reason:
        "This rule allows inbound traffic from any address on the internet to the listed ports.",
    },
  ],
});

export const SshKeyResourceType = rt({
  name: "SSH Key",
  id: "ssh-key",
  description: "An SSH public key registered to your Crusoe user",
  fields: [
    f("name", "Name"),
    f("fingerprint", "Fingerprint (SHA256)", { required: false }),
    f("publicKey", "Public Key", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  iconKey: "key",
  supportsCreate: true,
});

export const KubernetesClusterResourceType = rt({
  name: "Kubernetes Cluster",
  id: "kubernetes-cluster",
  description: "A Crusoe Managed Kubernetes (CMK) cluster",
  fields: [
    f("name", "Name"),
    f("state", "State", { required: false }),
    f("version", "Version"),
    f("location", "Location"),
    f("projectId", "Project"),
    f("nodePoolIds", "Node Pools", { required: false }),
    f("dnsName", "API Server DNS Name", { required: false }),
    f("private", "Private", { kind: "boolean", required: false }),
    f("subnetId", "Subnet", { required: false }),
    f("clusterCidr", "Pod CIDR", { required: false }),
    f("serviceCidr", "Service CIDR", { required: false }),
    f("routingMode", "Routing Mode", { required: false }),
    f("addOns", "Add-ons", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Admin-certificate kubeconfig for this cluster",
    }),
    o("clusterEndpoint", "Cluster Endpoint", {
      hidden: true,
      description: "HTTPS address of the Kubernetes API server",
    }),
  ],
  dependsOn: [
    {
      fieldKey: "subnetId",
      matchTemplate: "{projectId}/{subnetId}",
      targetTypeId: "vpc-subnet",
      label: "in subnet",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "kubernetes",
  supportsCreate: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
      exposeMetricsToParent: true,
    },
  ],
  secretExportTemplates: [
    {
      id: "crusoe-cmk-kubeconfig",
      displayName: "CMK Kubeconfig",
      description: "Kubeconfig for kubectl access to this Crusoe Managed Kubernetes cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "clusterEndpoint" },
      ],
    },
  ],
});

export const NodePoolResourceType = rt({
  name: "Node Pool",
  id: "node-pool",
  description: "A node pool of a Crusoe Managed Kubernetes cluster",
  fields: [
    f("name", "Name", { editable: false }),
    f("clusterId", "Cluster", { editable: false }),
    f("type", "Instance Type", { editable: false }),
    f("count", "Desired Nodes", {
      kind: "number",
      description: "How many nodes the pool should run. Lowering it drains and deletes nodes",
    }),
    f("currentCount", "Ready Nodes", { kind: "number", required: false, editable: false }),
    f("autoscaling", "Autoscaling", {
      kind: "boolean",
      required: false,
      description: "Let the Cluster Autoscaler size the pool between the minimum and maximum",
    }),
    f("minNodes", "Autoscaling Minimum", { kind: "number", required: false }),
    f("maxNodes", "Autoscaling Maximum", { kind: "number", required: false }),
    f("state", "State", { required: false, editable: false }),
    f("health", "Health", { required: false, editable: false }),
    f("subnetId", "Subnet", { required: false, editable: false }),
    f("reservationId", "Reservation", { required: false, editable: false }),
    f("publicIpType", "Public IP Type", { required: false, editable: false }),
    f("instanceIds", "Node VMs", { required: false, editable: false }),
    f("projectId", "Project", { editable: false }),
  ],
  dependsOn: [
    {
      fieldKey: "clusterId",
      matchTemplate: "{projectId}/{clusterId}",
      targetTypeId: "kubernetes-cluster",
      label: "node pool of",
    },
    {
      fieldKey: "instanceIds",
      matchTemplate: "{projectId}/{instanceIds}",
      targetTypeId: "vm",
      label: "runs",
    },
  ],
  parentTypeId: "kubernetes-cluster",
  showInSidebar: true,
  iconKey: "server",
  supportsCreate: true,
  // Edit = scale (count) and the autoscaling bounds.
  supportsUpdate: true,
});

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "load-balancer",
  description: "A Crusoe external load balancer",
  fields: [
    f("name", "Name"),
    f("location", "Location"),
    f("protocol", "Protocol", { required: false }),
    f("networkId", "VPC Network", { required: false }),
    f("listenPorts", "Listen Ports", { required: false }),
    f("backends", "Backends", { required: false }),
    f("projectId", "Project"),
  ],
  outputs: [o("vip", "Virtual IP")],
  dependsOn: [
    {
      fieldKey: "networkId",
      matchTemplate: "{projectId}/{networkId}",
      targetTypeId: "vpc-network",
      label: "in VPC",
    },
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "load-balancer",
});

export const ReservationResourceType = rt({
  name: "Reservation",
  id: "reservation",
  description: "A reserved-capacity contract for a Crusoe instance type",
  fields: [
    f("productLine", "Product Line"),
    f("reservationType", "Type", { required: false }),
    f("quantity", "Reserved", { kind: "number", required: false }),
    f("usedQuantity", "In Use", { kind: "number", required: false }),
    f("utilizationPercent", "Utilization (%)", { kind: "number", required: false }),
    f("locations", "Locations", { required: false }),
    f("projectIds", "Projects", { required: false }),
    f("vmIds", "VMs", { required: false }),
    f("contractStartDate", "Contract Start", { required: false }),
    f("contractEndDate", "Contract End", { required: false }),
    f("organizationId", "Organization ID", { required: false }),
  ],
  iconKey: "receipt",
  // Reservations are contracts; the API has no delete.
  supportsDelete: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ProjectResourceType,
  VmResourceType,
  DiskResourceType,
  SnapshotResourceType,
  VpcNetworkResourceType,
  VpcSubnetResourceType,
  FirewallRuleResourceType,
  KubernetesClusterResourceType,
  NodePoolResourceType,
  LoadBalancerResourceType,
  SshKeyResourceType,
  ReservationResourceType,
];
