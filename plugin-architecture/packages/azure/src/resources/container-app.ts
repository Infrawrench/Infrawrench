import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerAppResourceType = rt({
  name: "Container App",
  id: "azure-container-app",
  description:
    "An Azure Container Apps app: a serverless container with HTTP ingress, scale-to-zero and revisions, running inside a Container Apps environment",
  fields: [
    // Name, environment and placement are fixed at create time. The editable
    // fields all live in the app's `template`, so every edit rolls out a new
    // revision (Azure's own behaviour for template changes).
    f("name", "Name", { editable: false }),
    f("resourceGroup", "Resource Group", { editable: false }),
    f("location", "Location", { editable: false }),
    f("environment", "Environment", {
      editable: false,
      description: "Container Apps environment the app runs in",
    }),
    f("provisioningState", "Provisioning State", { editable: false }),
    f("runningStatus", "Running Status", { required: false, editable: false }),
    f("image", "Image", {
      description:
        "Image of the app's first container, e.g. myregistry.azurecr.io/api:1.4. Changing it rolls out a new revision",
    }),
    f("cpu", "CPU (cores)", {
      kind: "number",
      required: false,
      description:
        "vCPU for the first container. Consumption pairs CPU with memory at 1 core : 2 GiB (0.25/0.5Gi up to 4/8Gi)",
    }),
    f("memory", "Memory", {
      required: false,
      description: "Memory for the first container, e.g. 0.5Gi. Must match the CPU pairing",
    }),
    f("minReplicas", "Min Replicas", {
      kind: "number",
      required: false,
      description: "0 lets the app scale to zero when idle",
    }),
    f("maxReplicas", "Max Replicas", { kind: "number", required: false }),
    f("ingress", "Ingress", {
      required: false,
      editable: false,
      kind: "enum",
      enumValues: ["External", "Internal", "Disabled"],
    }),
    f("targetPort", "Target Port", { kind: "number", required: false, editable: false }),
    f("activeRevisionsMode", "Revisions Mode", { required: false, editable: false }),
    f("latestRevisionName", "Latest Revision", { required: false, editable: false }),
    f("workloadProfileName", "Workload Profile", { required: false, editable: false }),
    f("containerCount", "Containers", { kind: "number", required: false, editable: false }),
    f("containerRegistry", "Container Registry", { required: false, editable: false }),
    f("managedIdentities", "Managed Identities", { required: false, editable: false }),
  ],
  outputs: [
    o("fqdn", "FQDN"),
    o("url", "URL"),
    o("latestRevisionFqdn", "Latest Revision FQDN", { hidden: true }),
    o("outboundIpAddresses", "Outbound IPs"),
    o("resourceId", "Resource ID", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    {
      fieldKey: "environment",
      targetTypeId: "azure-container-app-environment",
      targetKey: "name",
      label: "runs in",
    },
    {
      fieldKey: "containerRegistry",
      targetTypeId: "azure-container-registry",
      targetKey: "loginServer",
      label: "pulls from",
    },
    {
      fieldKey: "managedIdentities",
      targetTypeId: "azure-managed-identity",
      targetKey: "name",
      label: "runs as",
    },
  ],
  iconKey: "container",
  // Sleep/wake schedules: containerApps start / stop. A stopped app scales to
  // zero and bills nothing for compute (environment-level charges such as
  // dedicated workload profiles keep billing).
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "runningStatus",
    runningValues: ["Running"],
    stoppedValues: ["Stopped"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});
