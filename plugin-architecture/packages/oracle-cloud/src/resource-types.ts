import { f, o, rt, type ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Resource types. Every OCI resource lives in a region and a compartment, and
 * the lister covers every subscribed region and every compartment the
 * credential can see, so `region` and `compartmentId` are on nearly every
 * type. External ids are OCIDs except where noted.
 */

const regionField = f("region", "Region", { editable: false });
const compartmentField = f("compartmentId", "Compartment", {
  editable: false,
  description: "OCID of the compartment the resource lives in",
});
const compartmentNameField = f("compartmentName", "Compartment Name", {
  required: false,
  editable: false,
});
const statusField = f("status", "Status", { required: false, editable: false });
const compartmentDep = {
  fieldKey: "compartmentId",
  targetTypeId: "compartment",
  label: "in compartment",
} as const;

export const TenancyResourceType = rt({
  id: "tenancy",
  name: "Tenancy",
  plural: "Tenancies",
  description:
    "The Oracle Cloud tenancy: home region, subscribed regions, month-to-date spend with OCI's forecast, subscription commitments and OCI's own carbon emissions report",
  fields: [
    f("name", "Name", { editable: false }),
    f("homeRegion", "Home Region", { editable: false }),
    f("subscribedRegions", "Subscribed Regions", { required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
  ],
  outputs: [o("id", "Tenancy OCID")],
  iconKey: "account",
  pinnable: true,
  supportsDelete: false,
});

export const CompartmentResourceType = rt({
  id: "compartment",
  name: "Compartment",
  description:
    "An OCI compartment: the folder every resource, policy and budget is scoped to. Compartments nest up to six levels deep.",
  fields: [
    f("name", "Name"),
    f("description", "Description"),
    f("parentId", "Parent Compartment", {
      editable: false,
      description: "OCID of the parent compartment (the tenancy OCID for a top-level one)",
    }),
    f("path", "Path", { required: false, editable: false }),
    statusField,
  ],
  outputs: [o("id", "Compartment OCID")],
  dependsOn: [{ fieldKey: "parentId", targetTypeId: "compartment", label: "inside" }],
  iconKey: "folder",
  supportsCreate: true,
  supportsUpdate: true,
});

export const InstanceResourceType = rt({
  id: "instance",
  name: "Compute Instance",
  description: "An OCI Compute virtual machine or bare metal instance",
  fields: [
    f("name", "Name"),
    regionField,
    f("availabilityDomain", "Availability Domain", { editable: false }),
    f("faultDomain", "Fault Domain", { required: false, editable: false }),
    compartmentField,
    compartmentNameField,
    f("size", "Size", {
      description:
        "Shape and capacity, e.g. VM.Standard.E4.Flex/2/32 (shape / OCPUs / memory GB) or a fixed shape such as VM.Standard2.2. Changing it resizes the instance; a running instance reboots.",
    }),
    f("shape", "Shape", { editable: false }),
    f("ocpus", "OCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("processor", "Processor", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: [
        "RUNNING",
        "STOPPED",
        "STARTING",
        "STOPPING",
        "PROVISIONING",
        "MOVING",
        "CREATING_IMAGE",
        "TERMINATING",
        "TERMINATED",
      ],
    }),
    f("imageName", "Image", { required: false, editable: false }),
    f("imageId", "Image OCID", { required: false, editable: false }),
    f("subnetId", "Subnet", { required: false, editable: false }),
    f("bootVolumeId", "Boot Volume", { required: false, editable: false }),
    f("billedWhenStopped", "Billed When Stopped", {
      kind: "boolean",
      required: false,
      editable: false,
      description:
        "Dense I/O, GPU and HPC shapes keep billing for compute while stopped; standard shapes pause compute billing (their volumes keep billing either way)",
    }),
    f("sshUsername", "SSH Username", { required: false, editable: false }),
    f("timeCreated", "Created", { required: false, editable: false }),
  ],
  outputs: [o("publicIp", "Public IP"), o("privateIp", "Private IP"), o("id", "Instance OCID")],
  dependsOn: [
    compartmentDep,
    { fieldKey: "subnetId", targetTypeId: "subnet", label: "attached to" },
    { fieldKey: "bootVolumeId", targetTypeId: "boot-volume", label: "boots from" },
  ],
  iconKey: "instance",
  supportsCreate: true,
  // Rename and resize (UpdateInstance with shape + shapeConfig).
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "START",
    stopActionId: "SOFTSTOP",
    statusFieldKey: "status",
    runningValues: ["RUNNING", "STARTING"],
    stoppedValues: ["STOPPED", "STOPPING"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "status", value: "RUNNING" },
    defaultUsername: "opc",
    usernameFieldKey: "sshUsername",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "ubuntu",
    // The agents flow submits only these; the create handler fills in the
    // home region and the region's first public subnet.
    defaultFields: {
      size: "VM.Standard.E4.Flex/1/16",
      image: "Canonical Ubuntu|24.04",
      availabilityDomain: "1",
    },
    linuxImageDefaults: { image: "Canonical Ubuntu|24.04" },
    hiddenFieldKeys: ["sshPublicKey"],
  },
  // The create form's size-picker lists every shape at a set of OCPU counts
  // with OCI's default memory per OCPU, priced from Oracle's public price
  // list. CPU and memory come from the Oracle Cloud Agent
  // (`oci_computeagent`), which is on by default on platform images.
  rightsizing: {
    sizeFieldKey: "size",
    regionFieldKey: "region",
    cpuMetric: { seriesLabel: "CPU Utilization" },
    memoryMetric: { seriesLabel: "Memory Utilization", interpretation: "percent" },
    // Keeps a candidate on the current shape series (E4.Flex stays E4.Flex,
    // VM.Standard2.4 may become VM.Standard2.2): crossing to another
    // processor or architecture needs a compatible image.
    sizeFamilyPattern: "^([^/]+?)(?:\\.\\d+)?(?:/|$)",
    resizeNote:
      "OCI reboots a running instance to apply a new shape or capacity. A stopped instance is resized in place and stays stopped.",
  },
  carbon: {
    regionFieldKey: "region",
    vcpus: { from: "field", fieldKey: "vcpus" },
  },
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "STOPPED" }],
    reason:
      "Instance is stopped. Its boot volume and any attached block volumes keep billing, and dense I/O, GPU and HPC shapes keep billing for compute too.",
  },
});

const VPU_DESCRIPTION =
  "Performance in VPUs per GB: 0 Lower Cost, 10 Balanced, 20 Higher Performance, 30 to 120 Ultra High Performance";

export const BootVolumeResourceType = rt({
  id: "boot-volume",
  name: "Boot Volume",
  description: "The boot disk of an OCI Compute instance",
  fields: [
    f("name", "Name"),
    regionField,
    f("availabilityDomain", "Availability Domain", { editable: false }),
    compartmentField,
    compartmentNameField,
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "OCI can only grow a volume, never shrink it",
    }),
    f("vpusPerGb", "Performance (VPUs/GB)", { kind: "number", description: VPU_DESCRIPTION }),
    statusField,
    f("attachedInstanceId", "Attached Instance", { required: false, editable: false }),
  ],
  outputs: [o("id", "Boot Volume OCID")],
  dependsOn: [
    compartmentDep,
    { fieldKey: "attachedInstanceId", targetTypeId: "instance", label: "attached to" },
  ],
  iconKey: "volume",
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "attachedInstanceId", when: "empty" }],
    reason:
      "Boot volume is not attached to any instance (usually left behind by a terminated instance) and keeps billing per GB-month",
  },
});

export const BlockVolumeResourceType = rt({
  id: "block-volume",
  name: "Block Volume",
  description: "An OCI Block Volume",
  fields: [
    f("name", "Name"),
    regionField,
    f("availabilityDomain", "Availability Domain", { editable: false }),
    compartmentField,
    compartmentNameField,
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "OCI can only grow a volume, never shrink it",
    }),
    f("vpusPerGb", "Performance (VPUs/GB)", { kind: "number", description: VPU_DESCRIPTION }),
    f("autoTune", "Performance Auto-tune", { kind: "boolean", required: false, editable: false }),
    statusField,
    f("attachedTo", "Attached Instances", {
      required: false,
      editable: false,
      description: "Comma-separated OCIDs of the instances this volume is attached to",
    }),
  ],
  outputs: [o("id", "Volume OCID")],
  dependsOn: [
    compartmentDep,
    { fieldKey: "attachedTo", targetTypeId: "instance", label: "attached to" },
  ],
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  attachTargets: [
    {
      pluginId: "oracle-cloud",
      resourceTypeId: "instance",
      matchField: "availabilityDomain",
      verb: "Attach",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "attachedTo", when: "empty" }],
    reason: "Block volume is not attached to any instance and keeps billing per GB-month",
  },
});

export const VcnResourceType = rt({
  id: "vcn",
  name: "VCN",
  plural: "VCNs",
  description: "An OCI Virtual Cloud Network",
  fields: [
    f("name", "Name"),
    regionField,
    compartmentField,
    compartmentNameField,
    f("cidrBlocks", "CIDR Blocks", { editable: false }),
    f("dnsLabel", "DNS Label", { required: false, editable: false }),
    f("domainName", "Domain Name", { required: false, editable: false }),
    f("defaultSecurityListId", "Default Security List", { required: false, editable: false }),
    statusField,
  ],
  outputs: [o("id", "VCN OCID")],
  dependsOn: [compartmentDep],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const SubnetResourceType = rt({
  id: "subnet",
  name: "Subnet",
  description: "A subnet inside an OCI VCN",
  fields: [
    f("name", "Name"),
    regionField,
    compartmentField,
    compartmentNameField,
    f("vcnId", "VCN", { editable: false }),
    f("cidrBlock", "CIDR Block", { editable: false }),
    f("availabilityDomain", "Availability Domain", {
      required: false,
      editable: false,
      description: "Empty for a regional subnet, which spans every availability domain",
    }),
    f("access", "Access", {
      kind: "enum",
      enumValues: ["public", "private"],
      editable: false,
      description: "Private subnets prohibit public IPs on their VNICs",
    }),
    f("securityListIds", "Security Lists", { required: false, editable: false }),
    f("dnsLabel", "DNS Label", { required: false, editable: false }),
    statusField,
  ],
  outputs: [o("id", "Subnet OCID")],
  dependsOn: [
    compartmentDep,
    { fieldKey: "vcnId", targetTypeId: "vcn", label: "in" },
    { fieldKey: "securityListIds", targetTypeId: "security-list", label: "protected by" },
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const SecurityListResourceType = rt({
  id: "security-list",
  name: "Security List",
  description: "A stateful or stateless firewall rule set applied to OCI subnets",
  fields: [
    f("name", "Name"),
    regionField,
    compartmentField,
    compartmentNameField,
    f("vcnId", "VCN", { editable: false }),
    f("ingressRules", "Ingress Rules", { required: false, editable: false }),
    f("egressRules", "Egress Rules", { required: false, editable: false }),
    f("ingressRuleCount", "Ingress Rule Count", { kind: "number", editable: false }),
    f("egressRuleCount", "Egress Rule Count", { kind: "number", editable: false }),
    f("internetOpenPorts", "Ports Open to the Internet", {
      required: false,
      editable: false,
      description:
        "TCP ports reachable from 0.0.0.0/0 by an ingress rule (all when a rule allows every port or protocol)",
    }),
    f("adminPortsOpen", "SSH/RDP Open to the Internet", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    statusField,
  ],
  outputs: [o("id", "Security List OCID")],
  dependsOn: [compartmentDep, { fieldKey: "vcnId", targetTypeId: "vcn", label: "in" }],
  iconKey: "firewall",
  supportsUpdate: true,
  postureChecks: [
    {
      id: "oci-security-list-admin-ports-open",
      title: "SSH or RDP open to the internet",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "adminPortsOpen", when: "truthy" }],
      reason:
        "An ingress rule allows 0.0.0.0/0 to reach SSH (22) or RDP (3389), so every subnet using this security list exposes remote administration to the internet.",
    },
  ],
});

export const ReservedIpResourceType = rt({
  id: "reserved-ip",
  name: "Reserved Public IP",
  description: "A reserved (persistent) OCI public IPv4 address",
  fields: [
    f("name", "Name"),
    regionField,
    compartmentField,
    compartmentNameField,
    f("ipAddress", "IP Address", { editable: false }),
    f("status", "Status", {
      required: false,
      editable: false,
      description: "AVAILABLE means reserved but not assigned to anything",
    }),
    f("assignedEntityId", "Assigned To", { required: false, editable: false }),
    f("assignedEntityType", "Assigned Entity Type", { required: false, editable: false }),
  ],
  outputs: [o("ipAddress", "IP Address"), o("id", "Public IP OCID")],
  dependsOn: [compartmentDep],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "assignedEntityId", when: "empty" }],
    reason:
      "Reserved public IP is not assigned to anything. OCI does not bill for the address, but it holds one of the tenancy's limited reserved IPs.",
  },
});

export const LoadBalancerResourceType = rt({
  id: "load-balancer",
  name: "Load Balancer",
  description: "An OCI flexible Load Balancer",
  fields: [
    f("name", "Name"),
    regionField,
    compartmentField,
    compartmentNameField,
    f("shape", "Shape", { editable: false }),
    f("minBandwidthMbps", "Minimum Bandwidth (Mbps)", {
      kind: "number",
      required: false,
      description: "Flexible shape floor, 10 to 8000 Mbps. Billed bandwidth never drops below it.",
    }),
    f("maxBandwidthMbps", "Maximum Bandwidth (Mbps)", {
      kind: "number",
      required: false,
      description: "Flexible shape ceiling, 10 to 8000 Mbps",
    }),
    f("isPrivate", "Private", { kind: "boolean", required: false, editable: false }),
    f("ipAddresses", "IP Addresses", { required: false, editable: false }),
    f("subnetIds", "Subnets", { required: false, editable: false }),
    f("backendSetCount", "Backend Sets", { kind: "number", required: false, editable: false }),
    f("listenerCount", "Listeners", { kind: "number", required: false, editable: false }),
    f("health", "Health", { required: false, editable: false }),
    statusField,
  ],
  outputs: [o("ipAddress", "IP Address"), o("id", "Load Balancer OCID")],
  dependsOn: [compartmentDep, { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in" }],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  orphanRule: {
    conditions: [{ fieldKey: "backendSetCount", when: "equals", value: "0" }],
    reason: "Load balancer has no backend sets, so it routes traffic nowhere while billing hourly",
  },
});

export const BucketResourceType = rt({
  id: "bucket",
  name: "Object Storage Bucket",
  description: "An OCI Object Storage bucket",
  fields: [
    f("name", "Name", { editable: false }),
    regionField,
    compartmentField,
    compartmentNameField,
    f("namespace", "Namespace", { editable: false }),
    f("storageTier", "Storage Tier", {
      kind: "enum",
      enumValues: ["Standard", "Archive"],
      editable: false,
    }),
    f("publicAccessType", "Public Access", {
      kind: "enum",
      enumValues: ["NoPublicAccess", "ObjectRead", "ObjectReadWithoutList"],
    }),
    f("versioning", "Versioning", {
      kind: "enum",
      enumValues: ["Enabled", "Suspended", "Disabled"],
    }),
    f("autoTiering", "Auto-Tiering", {
      kind: "enum",
      enumValues: ["Disabled", "InfrequentAccess"],
      description: "InfrequentAccess moves objects nobody reads to the cheaper tier automatically",
    }),
    f("approximateCount", "Objects (approx.)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("approximateSizeGb", "Size (GB, approx.)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("name", "Bucket Name"), o("namespace", "Namespace")],
  dependsOn: [compartmentDep],
  iconKey: "bucket",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  supportsStorageBrowser: true,
  postureChecks: [
    {
      id: "oci-bucket-public",
      title: "Bucket allows public access",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "publicAccessType", when: "notEquals", value: "NoPublicAccess" }],
      reason:
        "Anyone on the internet can read objects in this bucket without signing in (ObjectRead also lets them list every object name).",
    },
  ],
});

export const AutonomousDatabaseResourceType = rt({
  id: "autonomous-database",
  name: "Autonomous Database",
  description: "An Oracle Autonomous Database (serverless)",
  fields: [
    f("name", "Display Name"),
    f("dbName", "Database Name", { editable: false }),
    regionField,
    compartmentField,
    compartmentNameField,
    f("workload", "Workload", {
      kind: "enum",
      enumValues: ["OLTP", "DW", "AJD", "APEX", "LH"],
      editable: false,
      description:
        "OLTP Transaction Processing, DW / LH Lakehouse (Data Warehouse), AJD JSON Database, APEX",
    }),
    f("computeModel", "Compute Model", { editable: false }),
    f("computeCount", "Compute (ECPUs/OCPUs)", {
      kind: "number",
      description: "ECPU databases need at least 2. Scaling is online.",
    }),
    f("storageTb", "Storage (TB)", { kind: "number", required: false }),
    f("autoScaling", "Compute Auto Scaling", {
      kind: "boolean",
      required: false,
      description: "Lets the database use up to three times its base compute when busy",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("licenseModel", "License", { required: false, editable: false }),
    f("freeTier", "Always Free", { kind: "boolean", required: false, editable: false }),
    f("dbVersion", "Version", { required: false, editable: false }),
  ],
  outputs: [
    o("serviceConsoleUrl", "Service Console"),
    o("sqlDevWebUrl", "Database Actions"),
    o("connectionStringHigh", "Connection String (high)"),
    o("id", "Database OCID"),
  ],
  dependsOn: [compartmentDep],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["AVAILABLE", "STARTING"],
    stoppedValues: ["STOPPED", "STOPPING"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "STOPPED" }],
    reason: "Database is stopped: compute billing is paused but its storage keeps billing",
  },
});

export const OkeClusterResourceType = rt({
  id: "oke-cluster",
  name: "OKE Cluster",
  description: "An OCI Kubernetes Engine cluster",
  fields: [
    f("name", "Name"),
    regionField,
    compartmentField,
    compartmentNameField,
    f("kubernetesVersion", "Kubernetes Version", {
      description: "Pick a newer version to upgrade the control plane",
    }),
    f("clusterType", "Cluster Type", {
      kind: "enum",
      enumValues: ["BASIC_CLUSTER", "ENHANCED_CLUSTER"],
      description:
        "Enhanced clusters add an SLA and features such as virtual nodes, billed per cluster-hour. A basic cluster can be upgraded to enhanced, not back.",
    }),
    f("vcnId", "VCN", { required: false, editable: false }),
    f("endpoint", "API Endpoint", { required: false, editable: false }),
    f("availableUpgrades", "Available Upgrades", { required: false, editable: false }),
    statusField,
  ],
  outputs: [o("endpoint", "API Endpoint"), o("id", "Cluster OCID")],
  dependsOn: [compartmentDep, { fieldKey: "vcnId", targetTypeId: "vcn", label: "in" }],
  iconKey: "kubernetes",
  supportsUpdate: true,
  credentialFormats: [
    {
      id: "kubeconfig",
      label: "Kubeconfig",
      description:
        "A kubeconfig for kubectl. OKE kubeconfigs fetch a short-lived token through the OCI CLI, so the machine using it needs the OCI CLI configured.",
      mediaType: "text",
      filenameTemplate: "kubeconfig-{resource}.yaml",
    },
  ],
});

export const NodePoolResourceType = rt({
  id: "node-pool",
  name: "Node Pool",
  description: "A pool of worker nodes in an OKE cluster",
  parentTypeId: "oke-cluster",
  showInSidebar: true,
  fields: [
    f("name", "Name"),
    regionField,
    compartmentField,
    f("clusterId", "Cluster", { editable: false }),
    f("nodeShape", "Node Shape", { editable: false }),
    f("ocpus", "OCPUs per Node", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory per Node (GB)", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Node Count", {
      kind: "number",
      description: "Scale the pool by changing the number of nodes",
    }),
    f("kubernetesVersion", "Kubernetes Version", { required: false, editable: false }),
    statusField,
  ],
  outputs: [o("id", "Node Pool OCID")],
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "oke-cluster", label: "in" }],
  iconKey: "kubernetes",
  supportsUpdate: true,
});

export const BudgetResourceType = rt({
  id: "budget",
  name: "Budget",
  description:
    "An OCI budget: a monthly spend limit on a compartment or cost-tracking tag, with alert rules that email when actual or forecast spend crosses a threshold",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("amount", "Monthly Amount", {
      kind: "number",
      description: "Whole number, in the tenancy's billing currency",
    }),
    f("targetType", "Target Type", {
      kind: "enum",
      enumValues: ["COMPARTMENT", "TAG"],
      editable: false,
    }),
    f("targets", "Targets", {
      editable: false,
      description: "Compartment OCID, or namespace.key.value for a tag budget",
    }),
    f("processingPeriodType", "Budget Period", {
      kind: "enum",
      enumValues: ["MONTH", "INVOICE", "SINGLE_USE"],
      required: false,
      editable: false,
    }),
    f("actualSpend", "Actual Spend", { kind: "number", required: false, editable: false }),
    f("forecastedSpend", "Forecast Spend", { kind: "number", required: false, editable: false }),
    f("timeSpendComputed", "Spend Computed At", { required: false, editable: false }),
    f("alertRuleCount", "Alert Rules", { kind: "number", required: false, editable: false }),
    statusField,
  ],
  outputs: [o("id", "Budget OCID")],
  dependsOn: [{ fieldKey: "targets", targetTypeId: "compartment", label: "tracks" }],
  iconKey: "budget",
  supportsCreate: true,
  supportsUpdate: true,
});

export const BudgetAlertRuleResourceType = rt({
  id: "budget-alert-rule",
  name: "Budget Alert Rule",
  description: "An email alert on an OCI budget",
  parentTypeId: "budget",
  pinnable: false,
  fields: [
    f("name", "Name"),
    f("type", "Spend Type", {
      kind: "enum",
      enumValues: ["ACTUAL", "FORECAST"],
      description: "ACTUAL fires on spend so far, FORECAST on the projected month-end spend",
    }),
    f("thresholdType", "Threshold Type", { kind: "enum", enumValues: ["PERCENTAGE", "ABSOLUTE"] }),
    f("threshold", "Threshold", {
      kind: "number",
      description: "Percent of the budget, or an absolute amount in the billing currency",
    }),
    f("recipients", "Recipients", {
      required: false,
      description: "Email addresses, separated by commas",
    }),
    f("message", "Message", { required: false }),
    f("budgetId", "Budget", { editable: false }),
    statusField,
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "budgetId", targetTypeId: "budget", label: "on" }],
  iconKey: "bell",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  TenancyResourceType,
  CompartmentResourceType,
  InstanceResourceType,
  BootVolumeResourceType,
  BlockVolumeResourceType,
  VcnResourceType,
  SubnetResourceType,
  SecurityListResourceType,
  ReservedIpResourceType,
  LoadBalancerResourceType,
  BucketResourceType,
  AutonomousDatabaseResourceType,
  OkeClusterResourceType,
  NodePoolResourceType,
  BudgetResourceType,
  BudgetAlertRuleResourceType,
];
