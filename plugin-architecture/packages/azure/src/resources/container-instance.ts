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
    f("imageRegistries", "Image Registries", {
      required: false,
      description: "Registry hosts the group's images are pulled from",
    }),
    f("subnetRefs", "Subnets", { required: false }),
  ],
  outputs: [o("ipAddress", "IP Address"), o("fqdn", "FQDN")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    {
      fieldKey: "imageRegistries",
      targetTypeId: "azure-container-registry",
      targetKey: "loginServer",
      label: "pulls from",
    },
    { fieldKey: "subnetRefs", targetTypeId: "azure-subnet", label: "in subnet" },
  ],
  iconKey: "container",
  supportsCreate: true,
  supportsMetrics: true,
});
