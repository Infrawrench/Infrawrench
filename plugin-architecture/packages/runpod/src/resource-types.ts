import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Every Runpod object is addressed by a bare, account-unique id, so
 * externalIds are the Runpod id as-is. SSH keys have no id of their own on
 * Runpod's side; their externalId is the key's SHA256 fingerprint.
 *
 * `region` always holds a Runpod data center id (`EU-RO-1`, `US-TX-3`): it is
 * the field the status feed correlates on, and Runpod's status page names its
 * data center components with exactly those ids.
 */

export const POD_STATES = ["running", "starting", "stopped", "terminated", "unknown"] as const;

export const PodResourceType = rt({
  name: "Pod",
  id: "pod",
  description: "A Runpod GPU or CPU pod",
  fields: [
    f("name", "Name"),
    f("status", "Status", { kind: "enum", enumValues: [...POD_STATES], editable: false }),
    f("region", "Data Center", { required: false, editable: false }),
    f("location", "Location", { required: false, editable: false }),
    f("cloudType", "Cloud", {
      required: false,
      editable: false,
      description: "Secure Cloud (Runpod data centers) or Community Cloud (vetted hosts)",
    }),
    f("computeType", "Compute", { required: false, editable: false }),
    f("gpuType", "GPU", { required: false, editable: false }),
    f("gpuTypeId", "GPU Type ID", { required: false, editable: false }),
    f("gpuCount", "GPUs", { kind: "number", required: false, editable: false }),
    f("cpuFlavorId", "CPU Flavor", { required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("interruptible", "Spot (Interruptible)", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("imageName", "Container Image", {
      required: false,
      description: "Changing the image resets the pod: anything outside the volume is lost",
    }),
    f("containerDiskGb", "Container Disk (GB)", {
      kind: "number",
      required: false,
      description: "Wiped on every restart. Changing it resets the pod",
    }),
    f("volumeGb", "Pod Volume (GB)", {
      kind: "number",
      required: false,
      description: "Persistent across restarts; billed while the pod is stopped. Can only grow",
    }),
    f("volumeMountPath", "Volume Mount Path", { required: false }),
    f("ports", "Exposed Ports", {
      required: false,
      description: "Comma-separated port/protocol pairs, e.g. 8888/http,22/tcp",
    }),
    f("locked", "Locked", {
      kind: "boolean",
      required: false,
      description: "A locked pod cannot be stopped or reset until it is unlocked",
    }),
    f("envKeys", "Environment Variables", {
      required: false,
      editable: false,
      description: "Names only; values are not synced",
    }),
    f("costPerHr", "Cost ($/hr)", { kind: "number", required: false, editable: false }),
    f("adjustedCostPerHr", "Effective Cost ($/hr)", {
      kind: "number",
      required: false,
      editable: false,
      description: "After active savings plans",
    }),
    f("templateId", "Template", { required: false, editable: false }),
    f("networkVolumeId", "Network Volume", { required: false, editable: false }),
    f("containerRegistryAuthId", "Registry Credentials", { required: false, editable: false }),
    f("endpointId", "Serverless Endpoint", {
      required: false,
      editable: false,
      description: "Set when the pod is a Serverless worker",
    }),
    f("gpuUtilPercent", "GPU Utilization (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("gpuMemoryUtilPercent", "GPU Memory Utilization (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("cpuPercent", "CPU Utilization (%)", { kind: "number", required: false, editable: false }),
    f("memoryPercent", "Memory Utilization (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("uptimeSeconds", "Uptime (s)", { kind: "number", required: false, editable: false }),
    f("sshUser", "SSH Proxy User", { required: false, editable: false }),
    f("machineId", "Machine", { required: false, editable: false }),
    f("maintenance", "Host Maintenance", { required: false, editable: false }),
    f("lastStatusChange", "Last Status Change", { required: false, editable: false }),
    f("lastStartedAt", "Last Started", { required: false, editable: false }),
  ],
  outputs: [
    o("publicIp", "Public IP"),
    o("sshCommand", "SSH Command", {
      description: "Through Runpod's SSH proxy; works for any pod with SSH enabled",
    }),
    o("directSshCommand", "Direct SSH Command", {
      description: "Over the pod's public IP and mapped TCP port, which also allows SCP and SFTP",
    }),
    o("sshProxyHost", "SSH Proxy Host", { hidden: true }),
    o("httpProxyUrl", "HTTP Proxy URL", {
      description: "https://<pod>-<port>.proxy.runpod.net for the first exposed HTTP port",
    }),
  ],
  dependsOn: [
    { fieldKey: "networkVolumeId", targetTypeId: "network-volume", label: "mounts" },
    { fieldKey: "templateId", targetTypeId: "template", label: "from template" },
    { fieldKey: "endpointId", targetTypeId: "serverless-endpoint", label: "worker of" },
    {
      fieldKey: "containerRegistryAuthId",
      targetTypeId: "container-registry-auth",
      label: "pulls with",
    },
  ],
  showInSidebar: true,
  iconKey: "server",
  supportsCreate: true,
  supportsUpdate: true,
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  sshEndpoint: {
    hostOutputKey: "sshProxyHost",
    runningWhen: { fieldKey: "status", value: "running" },
    usernameFieldKey: "sshUser",
    defaultUsername: "root",
  },
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "stopped" }],
    reason:
      "Pod is stopped. Runpod stops billing GPU time, but keeps billing its pod volume until the pod is terminated.",
  },
});

export const ServerlessEndpointResourceType = rt({
  name: "Serverless Endpoint",
  id: "serverless-endpoint",
  description: "A Runpod Serverless endpoint and its autoscaling worker pool",
  fields: [
    f("name", "Name"),
    f("computeType", "Compute", { required: false, editable: false }),
    f("templateId", "Template", { required: false, editable: false }),
    f("gpuTypeIds", "GPU Types", {
      required: false,
      editable: false,
      description: "In order of preference",
    }),
    f("gpuCount", "GPUs per Worker", { kind: "number", required: false, editable: false }),
    f("workersMin", "Active Workers (min)", {
      kind: "number",
      required: false,
      description: "Always-on workers. They bill continuously, even with an empty queue",
    }),
    f("workersMax", "Max Workers", { kind: "number", required: false }),
    f("idleTimeout", "Idle Timeout (s)", { kind: "number", required: false }),
    f("scalerType", "Scaling", {
      kind: "enum",
      enumValues: ["QUEUE_DELAY", "REQUEST_COUNT"],
      required: false,
    }),
    f("scalerValue", "Scaling Threshold", {
      kind: "number",
      required: false,
      description: "Seconds in queue (QUEUE_DELAY) or requests per worker (REQUEST_COUNT)",
    }),
    f("executionTimeoutMs", "Execution Timeout (ms)", { kind: "number", required: false }),
    f("flashboot", "FlashBoot", { kind: "boolean", required: false }),
    f("dataCenters", "Data Centers", { required: false, editable: false }),
    f("region", "Primary Data Center", { required: false, editable: false }),
    f("networkVolumeId", "Network Volume", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("jobsInQueue", "Jobs in Queue", { kind: "number", required: false, editable: false }),
    f("jobsInProgress", "Jobs in Progress", { kind: "number", required: false, editable: false }),
    f("jobsCompleted", "Jobs Completed", { kind: "number", required: false, editable: false }),
    f("jobsFailed", "Jobs Failed", { kind: "number", required: false, editable: false }),
    f("workersRunning", "Workers Running", { kind: "number", required: false, editable: false }),
    f("workersIdle", "Workers Idle", { kind: "number", required: false, editable: false }),
    f("workersThrottled", "Workers Throttled", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("workersUnhealthy", "Workers Unhealthy", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("runUrl", "Async Run URL"),
    o("runSyncUrl", "Sync Run URL"),
    o("openAiBaseUrl", "OpenAI-compatible Base URL", {
      description: "For vLLM workers that serve the OpenAI API",
    }),
    o("endpointId", "Endpoint ID"),
  ],
  dependsOn: [
    { fieldKey: "templateId", targetTypeId: "template", label: "runs" },
    { fieldKey: "networkVolumeId", targetTypeId: "network-volume", label: "mounts" },
  ],
  showInSidebar: true,
  iconKey: "function",
  supportsCreate: true,
  supportsUpdate: true,
  secretExportTemplates: [
    {
      id: "runpod-serverless",
      displayName: "Runpod Serverless endpoint",
      description: "The endpoint's run URLs for a client app (bring your own RUNPOD_API_KEY)",
      entries: [
        { envKey: "RUNPOD_ENDPOINT_ID", outputKey: "endpointId" },
        { envKey: "RUNPOD_ENDPOINT_URL", outputKey: "runSyncUrl" },
      ],
    },
  ],
});

export const TemplateResourceType = rt({
  name: "Template",
  id: "template",
  description: "A reusable Runpod pod or Serverless worker definition",
  fields: [
    f("name", "Name"),
    f("imageName", "Container Image"),
    f("isServerless", "Serverless", { kind: "boolean", required: false, editable: false }),
    f("category", "Category", { required: false, editable: false }),
    f("containerDiskGb", "Container Disk (GB)", { kind: "number", required: false }),
    f("volumeGb", "Volume (GB)", { kind: "number", required: false }),
    f("volumeMountPath", "Volume Mount Path", { required: false }),
    f("ports", "Exposed Ports", {
      required: false,
      description: "Comma-separated port/protocol pairs, e.g. 8888/http,22/tcp",
    }),
    f("startCommand", "Start Command", {
      required: false,
      description: "Overrides the image CMD; leave empty to use the image's own",
    }),
    f("envKeys", "Environment Variables", {
      required: false,
      editable: false,
      description: "Names only; values are not synced",
    }),
    f("containerRegistryAuthId", "Registry Credentials", { required: false, editable: false }),
    f("isPublic", "Public", {
      kind: "boolean",
      required: false,
      description: "Visible to every Runpod user (pod templates only)",
    }),
    f("readme", "Readme", { required: false }),
    f("earned", "Credits Earned", { kind: "number", required: false, editable: false }),
  ],
  dependsOn: [
    {
      fieldKey: "containerRegistryAuthId",
      targetTypeId: "container-registry-auth",
      label: "pulls with",
    },
  ],
  showInSidebar: true,
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
});

export const NetworkVolumeResourceType = rt({
  name: "Network Volume",
  id: "network-volume",
  description: "Persistent network storage in one Runpod data center",
  fields: [
    f("name", "Name"),
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "Runpod can only grow a network volume, never shrink it",
    }),
    f("region", "Data Center", { editable: false }),
    f("attachedTo", "Used By", {
      required: false,
      editable: false,
      description: "IDs of the pods and Serverless endpoints that mount this volume",
    }),
  ],
  showInSidebar: true,
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  // The lister always writes attachedTo ("" when unused).
  orphanRule: {
    conditions: [{ fieldKey: "attachedTo", when: "equals", value: "" }],
    reason:
      "No pod or Serverless endpoint mounts this network volume, but Runpod bills its full size every hour.",
  },
});

export const ContainerRegistryAuthResourceType = rt({
  name: "Container Registry Credential",
  id: "container-registry-auth",
  description: "Username and password Runpod uses to pull private container images",
  fields: [f("name", "Name")],
  iconKey: "key",
  supportsCreate: true,
});

export const SshKeyResourceType = rt({
  name: "SSH Key",
  id: "ssh-key",
  description: "An SSH public key Runpod installs on every new pod",
  fields: [
    f("name", "Name"),
    f("keyType", "Type", { required: false }),
    f("fingerprint", "Fingerprint (SHA256)", { required: false }),
    f("publicKey", "Public Key", { required: false }),
  ],
  iconKey: "key",
  supportsCreate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  PodResourceType,
  ServerlessEndpointResourceType,
  TemplateResourceType,
  NetworkVolumeResourceType,
  ContainerRegistryAuthResourceType,
  SshKeyResourceType,
];
