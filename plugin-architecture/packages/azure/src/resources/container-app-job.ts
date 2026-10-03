import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerAppJobResourceType = rt({
  name: "Container Apps Job",
  id: "azure-container-app-job",
  description:
    "An Azure Container Apps job: a container that runs to completion on a schedule, on demand, or per event, inside a Container Apps environment",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("environment", "Environment"),
    f("provisioningState", "Provisioning State"),
    f("triggerType", "Trigger", { kind: "enum", enumValues: ["Manual", "Schedule", "Event"] }),
    f("cronExpression", "Schedule (cron)", { required: false }),
    f("image", "Image", { required: false }),
    f("cpu", "CPU (cores)", { kind: "number", required: false }),
    f("memory", "Memory", { required: false }),
    f("parallelism", "Parallelism", { kind: "number", required: false }),
    f("replicaTimeout", "Replica Timeout (s)", { kind: "number", required: false }),
    f("replicaRetryLimit", "Retry Limit", { kind: "number", required: false }),
    f("workloadProfileName", "Workload Profile", { required: false }),
    f("containerRegistry", "Container Registry", { required: false }),
    f("managedIdentities", "Managed Identities", { required: false }),
  ],
  outputs: [o("resourceId", "Resource ID", { hidden: true })],
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
  iconKey: "batch",
  supportsMetrics: true,
});
