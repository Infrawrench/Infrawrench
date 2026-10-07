import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * externalIds are Vast's numeric ids as strings, except account environment
 * variables, which Vast addresses by key. Vast has no regions: `location` is
 * the host's geolocation string ("California, US").
 */

export const INSTANCE_STATES = [
  "running",
  "loading",
  "created",
  "stopped",
  "exited",
  "offline",
  "unknown",
] as const;

export const InstanceResourceType = rt({
  name: "Instance",
  id: "instance",
  description: "A Vast.ai GPU instance rented from a marketplace host",
  fields: [
    f("label", "Label", { required: false }),
    f("status", "Status", { kind: "enum", enumValues: [...INSTANCE_STATES], editable: false }),
    f("intendedStatus", "Intended Status", { required: false, editable: false }),
    f("statusMessage", "Status Message", { required: false, editable: false }),
    f("gpuName", "GPU", { required: false, editable: false }),
    f("numGpus", "GPUs", { kind: "number", required: false, editable: false }),
    f("gpuRamGb", "VRAM per GPU (GB)", { kind: "number", required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("ramGb", "RAM (GB)", { kind: "number", required: false, editable: false }),
    f("diskGb", "Disk (GB)", { kind: "number", required: false, editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("templateName", "Template", { required: false, editable: false }),
    f("templateId", "Template ID", { required: false, editable: false }),
    f("pricing", "Pricing", {
      kind: "enum",
      enumValues: ["on-demand", "interruptible"],
      required: false,
      editable: false,
    }),
    f("pricePerHour", "Price ($/hr)", {
      kind: "number",
      required: false,
      editable: false,
      description: "GPU, storage and the host's other hourly charges",
    }),
    f("bidPrice", "Bid ($/hr)", {
      kind: "number",
      required: false,
      description:
        "Interruptible instances only. Raising it above competing bids keeps the instance running",
    }),
    f("minBid", "Minimum Bid ($/hr)", { kind: "number", required: false, editable: false }),
    f("location", "Location", { required: false, editable: false }),
    f("machineId", "Machine", { required: false, editable: false }),
    f("hostId", "Host", { required: false, editable: false }),
    f("verification", "Host Verification", { required: false, editable: false }),
    f("reliability", "Host Reliability (%)", { kind: "number", required: false, editable: false }),
    f("gpuUtilPercent", "GPU Utilization (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("gpuTempC", "GPU Temperature (°C)", { kind: "number", required: false, editable: false }),
    f("cpuUtilPercent", "CPU Utilization (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("diskUsagePercent", "Disk Usage (%)", { kind: "number", required: false, editable: false }),
    f("cudaMax", "Max CUDA", { required: false, editable: false }),
    f("volumeIds", "Volumes", { required: false, editable: false }),
    f("startedAt", "Started", { required: false, editable: false }),
    f("contractEnd", "Host Contract Ends", {
      required: false,
      editable: false,
      description: "When the host's offer expires and the instance can be reclaimed",
    }),
  ],
  outputs: [
    o("sshCommand", "SSH Command", { description: "Through Vast's SSH proxy" }),
    o("directSshCommand", "Direct SSH Command", {
      description: "Over the host's public IP and mapped port, when direct SSH is enabled",
    }),
    o("publicIp", "Public IP"),
    o("sshHost", "SSH Host", { hidden: true }),
    o("sshPort", "SSH Port", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "volumeIds", targetTypeId: "volume", label: "uses volume" },
    { fieldKey: "templateId", targetTypeId: "template", label: "from template" },
  ],
  showInSidebar: true,
  iconKey: "server",
  supportsCreate: true,
  // Edit = relabel, and change the bid of an interruptible instance.
  supportsUpdate: true,
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["running"],
    stoppedValues: ["stopped", "exited"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "stopped" }],
    reason:
      "Instance is stopped. Vast stops billing GPU time but keeps billing its disk storage until the instance is destroyed.",
  },
  expiryFields: [
    {
      fieldKey: "contractEnd",
      from: "expiry",
      kind: "other",
      label: "Host rental contract ends",
    },
  ],
});

export const TemplateResourceType = rt({
  name: "Template",
  id: "template",
  description: "A Vast.ai launch template (image, launch mode, environment, start script)",
  fields: [
    f("name", "Name"),
    f("image", "Image"),
    f("tag", "Tag", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("diskGb", "Recommended Disk (GB)", { kind: "number", required: false }),
    f("runtype", "Launch Mode", { required: false, editable: false }),
    f("sshDirect", "Direct SSH", { kind: "boolean", required: false, editable: false }),
    f("private", "Private", { kind: "boolean", required: false, editable: false }),
    f("envKeys", "Environment Variables", {
      required: false,
      editable: false,
      description: "Names only; values are not synced",
    }),
    f("ports", "Ports", { required: false, editable: false }),
    f("hashId", "Hash ID", {
      required: false,
      editable: false,
      description: "Changes every time the template is edited",
    }),
    f("timesUsed", "Instances Created", { kind: "number", required: false, editable: false }),
  ],
  showInSidebar: true,
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
});

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Vast.ai storage volume on one host machine",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("location", "Location", { required: false, editable: false }),
    f("machineId", "Machine", { required: false, editable: false }),
    f("diskName", "Disk", { required: false, editable: false }),
    f("pricePerHour", "Price ($/hr)", { kind: "number", required: false, editable: false }),
    f("instanceIds", "Used By", {
      required: false,
      editable: false,
      description: "IDs of the instances using this volume",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "instanceIds", targetTypeId: "instance", label: "used by" }],
  showInSidebar: true,
  iconKey: "volume",
  supportsCreate: true,
  orphanRule: {
    conditions: [{ fieldKey: "instanceIds", when: "equals", value: "" }],
    reason:
      "No instance uses this volume, but Vast bills its storage every hour until it is deleted.",
  },
});

export const SshKeyResourceType = rt({
  name: "SSH Key",
  id: "ssh-key",
  description: "An SSH public key Vast installs on your instances",
  fields: [
    f("name", "Name", { editable: false }),
    f("publicKey", "Public Key", { description: "Replacing it updates the key on Vast" }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
});

export const EndpointResourceType = rt({
  name: "Serverless Endpoint",
  id: "serverless-endpoint",
  description: "A Vast.ai Serverless endpoint and its autoscaling targets",
  fields: [
    f("name", "Name"),
    f("state", "State", { required: false, editable: false }),
    f("maxWorkers", "Max Workers", { kind: "number", required: false }),
    f("coldWorkers", "Cold Workers", {
      kind: "number",
      required: false,
      description: "Workers kept stopped and ready when there is no load",
    }),
    f("minLoad", "Minimum Load", {
      kind: "number",
      required: false,
      description: "Floor load in perf units per second (tokens/s for LLMs)",
    }),
    f("targetUtil", "Target Utilization", {
      kind: "number",
      required: false,
      description: "Fraction of capacity to aim for, at most 1.0",
    }),
    f("coldMult", "Cold Capacity Multiplier", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  showInSidebar: true,
  iconKey: "function",
  supportsCreate: true,
  supportsUpdate: true,
});

export const WorkergroupResourceType = rt({
  name: "Workergroup",
  id: "workergroup",
  description: "A group of Vast.ai Serverless workers launched from one template for an endpoint",
  fields: [
    f("endpointId", "Endpoint", { editable: false }),
    f("endpointName", "Endpoint Name", { required: false, editable: false }),
    f("templateHash", "Template Hash", { required: false, editable: false }),
    f("templateId", "Template", { required: false, editable: false }),
    f("searchQuery", "Offer Filter", {
      required: false,
      description:
        "Vast search query for the machines workers run on, e.g. gpu_name=RTX_4090 num_gpus=1",
    }),
    f("gpuRamGb", "Minimum VRAM (GB)", { kind: "number", required: false }),
    f("testWorkers", "Test Workers", { kind: "number", required: false }),
    f("launchArgs", "Launch Arguments", { required: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [
    { fieldKey: "endpointId", targetTypeId: "serverless-endpoint", label: "serves" },
    { fieldKey: "templateId", targetTypeId: "template", label: "runs" },
  ],
  parentTypeId: "serverless-endpoint",
  showInSidebar: true,
  iconKey: "layers",
  supportsCreate: true,
  supportsUpdate: true,
});

export const EnvVarResourceType = rt({
  name: "Account Environment Variable",
  id: "env-var",
  description: "An encrypted environment variable Vast injects into every instance you launch",
  fields: [
    f("key", "Key", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description:
        "Never synced. Enter a new value to replace it; leave blank to keep the current one",
    }),
  ],
  iconKey: "secret",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  InstanceResourceType,
  TemplateResourceType,
  VolumeResourceType,
  SshKeyResourceType,
  EndpointResourceType,
  WorkergroupResourceType,
  EnvVarResourceType,
];
