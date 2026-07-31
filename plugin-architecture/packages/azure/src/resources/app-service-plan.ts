import { f, o, rt } from "@infrawrench/plugin-base";

export const AppServicePlanResourceType = rt({
  name: "App Service Plan",
  id: "azure-app-service-plan",
  description: "An Azure App Service plan — the compute the web apps and function apps run on",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("kind", "Kind", { required: false }),
    f("sku", "SKU", { required: false, description: "SKU name, e.g. P1v3" }),
    f("tier", "Tier", { required: false, description: "Service tier, e.g. PremiumV3" }),
    f("size", "Size", { required: false }),
    f("capacity", "Capacity", {
      kind: "number",
      required: false,
      description: "Instances the SKU is scaled to",
    }),
    f("workerCount", "Instances", {
      kind: "number",
      required: false,
      description: "Instances currently assigned to the plan",
    }),
    f("maximumWorkers", "Max Instances", { kind: "number", required: false }),
    f("operatingSystem", "Operating System", {
      required: false,
      description: "Linux or Windows workers",
    }),
    f("siteCount", "Apps", {
      kind: "number",
      required: false,
      description: "Web apps and function apps assigned to the plan",
    }),
    f("status", "Status", { required: false }),
    f("provisioningState", "Provisioning State", { required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "instance",
  supportsMetrics: true,
  // A dedicated plan bills for its reserved instances whether or not anything
  // runs on them, so an empty one is pure waste. The tiers that bill per
  // execution rather than per instance (Free, and the Functions consumption
  // tiers) cost nothing when empty, so they are excluded rather than reported
  // as a saving that isn't there.
  orphanRule: {
    conditions: [
      { fieldKey: "siteCount", when: "equals", value: "0" },
      { fieldKey: "tier", when: "notEquals", value: "Free" },
      { fieldKey: "tier", when: "notEquals", value: "Dynamic" },
      { fieldKey: "tier", when: "notEquals", value: "FlexConsumption" },
    ],
    reason: "App Service plan has no apps assigned but still bills for its reserved instances",
  },
});
