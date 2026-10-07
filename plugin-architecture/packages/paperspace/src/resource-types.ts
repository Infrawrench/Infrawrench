import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * externalIds are Paperspace ids; public IPs are addressed by the address
 * itself. `region` holds Paperspace region codes (`ny2`, `ca1`, `ams1`), which
 * the status page names as "US (NY2)" and the like.
 */

export const MACHINE_STATES = [
  "off",
  "starting",
  "stopping",
  "restarting",
  "serviceready",
  "ready",
  "upgrading",
  "provisioning",
] as const;

export const AUTO_SNAPSHOT_FREQUENCIES = ["hourly", "daily", "weekly", "monthly"];

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A Paperspace project, which holds deployments",
  fields: [
    f("name", "Name"),
    f("repoName", "GitHub Repository", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "folder",
  supportsCreate: true,
  supportsUpdate: true,
});

export const MachineResourceType = rt({
  name: "Machine",
  id: "machine",
  description: "A Paperspace GPU or CPU virtual machine",
  fields: [
    f("name", "Name"),
    f("state", "State", { kind: "enum", enumValues: [...MACHINE_STATES], editable: false }),
    f("machineType", "Machine Type", {
      description: "Changing it resizes the machine; Paperspace requires it to be off",
    }),
    f("region", "Region", { editable: false }),
    f("os", "Operating System", { required: false, editable: false }),
    f("gpu", "GPU", { required: false, editable: false }),
    f("gpuCount", "GPUs", { kind: "number", required: false, editable: false }),
    f("cpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("ramGb", "RAM (GB)", { kind: "number", required: false, editable: false }),
    f("storageTotalGb", "Disk (GB)", { kind: "number", required: false, editable: false }),
    f("storageUsedGb", "Disk Used (GB)", { kind: "number", required: false, editable: false }),
    f("usageRate", "Usage Rate ($/hr)", { kind: "number", required: false, editable: false }),
    f("storageRate", "Storage Rate ($/month)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("publicIpType", "Public IP", {
      kind: "enum",
      enumValues: ["static", "dynamic", "none"],
      required: false,
    }),
    f("networkId", "Private Network", { required: false, editable: false }),
    f("autoShutdownEnabled", "Auto Shutdown", { kind: "boolean", required: false }),
    f("autoShutdownTimeout", "Auto Shutdown After (hours)", { kind: "number", required: false }),
    f("autoShutdownForce", "Force Auto Shutdown", {
      kind: "boolean",
      required: false,
      description: "Shut down even when a user is still connected",
    }),
    f("autoSnapshotEnabled", "Auto Snapshots", { kind: "boolean", required: false }),
    f("autoSnapshotFrequency", "Auto Snapshot Frequency", {
      kind: "enum",
      enumValues: AUTO_SNAPSHOT_FREQUENCIES,
      required: false,
    }),
    f("autoSnapshotSaveCount", "Auto Snapshots Kept", { kind: "number", required: false }),
    f("updatesPending", "Updates Pending", { kind: "boolean", required: false, editable: false }),
    f("reservation", "Reservation", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("publicIp", "Public IP"),
    o("privateIp", "Private IP"),
    o("sshCommand", "SSH Command"),
  ],
  dependsOn: [{ fieldKey: "networkId", targetTypeId: "private-network", label: "in network" }],
  showInSidebar: true,
  iconKey: "server",
  supportsCreate: true,
  supportsUpdate: true,
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["ready", "serviceready"],
    stoppedValues: ["off"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "state", value: "ready" },
    // Paperspace's Linux templates create a `paperspace` user.
    defaultUsername: "paperspace",
  },
  orphanRule: {
    conditions: [{ fieldKey: "state", when: "equals", value: "off" }],
    reason:
      "Machine is off. Paperspace stops billing compute, but keeps billing its disk every month until it is deleted.",
  },
});

export const SharedDriveResourceType = rt({
  name: "Shared Drive",
  id: "shared-drive",
  description: "Network storage that machines on a private network mount over SMB",
  fields: [
    f("name", "Name"),
    f("sizeGb", "Size (GB)", { kind: "number", editable: false }),
    f("region", "Region", { editable: false }),
    f("networkId", "Private Network", { editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("mountPoint", "Mount Point"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true, hidden: true }),
  ],
  dependsOn: [{ fieldKey: "networkId", targetTypeId: "private-network", label: "in network" }],
  showInSidebar: true,
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
});

export const SnapshotResourceType = rt({
  name: "Snapshot",
  id: "snapshot",
  description: "A point-in-time snapshot of a Paperspace machine's disk",
  fields: [
    f("name", "Name"),
    f("machineId", "Machine", { editable: false }),
    f("automatic", "Automatic", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "machineId", targetTypeId: "machine", label: "snapshot of" }],
  showInSidebar: true,
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
});

export const CustomTemplateResourceType = rt({
  name: "Custom Template",
  id: "custom-template",
  description: "A machine image made from one of your machines, for creating new ones",
  fields: [
    f("name", "Name"),
    f("os", "Operating System", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("defaultSizeGb", "Default Disk (GB)", { kind: "number", required: false, editable: false }),
    f("machineTypes", "Machine Types", { required: false, editable: false }),
    f("parentMachineId", "Made From", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "parentMachineId", targetTypeId: "machine", label: "made from" }],
  showInSidebar: true,
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
});

export const PrivateNetworkResourceType = rt({
  name: "Private Network",
  id: "private-network",
  description: "A private network machines and shared drives in one region join",
  fields: [
    f("name", "Name"),
    f("region", "Region", { editable: false }),
    f("cidr", "Network", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  showInSidebar: true,
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const PublicIpResourceType = rt({
  name: "Public IP",
  id: "public-ip",
  description: "A static public IP claimed in a region and assigned to a machine",
  fields: [
    f("ip", "Address", { editable: false }),
    f("region", "Region", { editable: false }),
    f("machineId", "Assigned To", { required: false, editable: false }),
    f("createdAt", "Claimed", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "machineId", targetTypeId: "machine", label: "assigned to" }],
  showInSidebar: true,
  iconKey: "ip",
  supportsCreate: true,
  attachTargets: [
    { pluginId: "paperspace", resourceTypeId: "machine", matchField: "region", verb: "Assign" },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "machineId", when: "equals", value: "" }],
    reason: "Static IP is not assigned to any machine but is still billed every month.",
  },
});

export const StartupScriptResourceType = rt({
  name: "Startup Script",
  id: "startup-script",
  description: "A script Paperspace runs when the machines it is assigned to boot",
  fields: [
    f("name", "Name"),
    f("script", "Script", {
      required: false,
      description: "Paperspace never returns the script body; enter a new one to replace it",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("runOnce", "Run Once", {
      kind: "boolean",
      required: false,
      description: "Only on first boot instead of every boot",
    }),
    f("machineIds", "Assigned Machines", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "machineIds", targetTypeId: "machine", label: "runs on" }],
  showInSidebar: true,
  iconKey: "code",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [{ pluginId: "paperspace", resourceTypeId: "machine", verb: "Assign" }],
});

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "deployment",
  description: "A Paperspace container deployment serving a model or app",
  fields: [
    f("name", "Name", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("machineType", "Machine Type", { required: false, editable: false }),
    f("replicas", "Replicas", { kind: "number", required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("endpointUrl", "Endpoint URL")],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "project", label: "in project" }],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "deployment",
  supportsMetrics: true,
});

export const ContainerRegistryResourceType = rt({
  name: "Container Registry",
  id: "container-registry",
  description: "Credentials deployments use to pull private container images",
  fields: [
    f("name", "Name"),
    f("kind", "Kind", {
      kind: "enum",
      enumValues: ["other", "dockerhub", "gcr", "ghcr", "digitalocean", "azure"],
      required: false,
    }),
    f("url", "URL"),
    f("namespace", "Namespace"),
    f("username", "Username"),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Never synced. Enter a new one to replace it",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ProjectResourceType,
  MachineResourceType,
  SharedDriveResourceType,
  SnapshotResourceType,
  CustomTemplateResourceType,
  PrivateNetworkResourceType,
  PublicIpResourceType,
  StartupScriptResourceType,
  DeploymentResourceType,
  ContainerRegistryResourceType,
];
