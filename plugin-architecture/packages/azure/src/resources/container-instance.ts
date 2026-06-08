import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerInstanceResourceType = rt({
  name: "Container Instance",
  id: "azure-container-instance",
  description: "An Azure Container Instances group",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("provisioningState", "Provisioning State"),
    f("osType", "OS Type"),
    f("restartPolicy", "Restart Policy", { required: false }),
    f("containers", "Containers", { kind: "number", required: false }),
    f("ipAddress", "IP Address", { required: false }),
    f("fqdn", "FQDN", { required: false }),
  ],
  outputs: [o("ipAddress", "IP Address"), o("fqdn", "FQDN")],
  iconKey: "container",
  supportsCreate: true,
  supportsMetrics: true,
});
