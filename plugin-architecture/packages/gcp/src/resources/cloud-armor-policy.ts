import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudArmorPolicyResourceType: ResourceTypeDefinition = {
  id: "cloud-armor-policy",
  displayName: "Cloud Armor Policy",
  pluralDisplayName: "Cloud Armor Policies",
  description: "A Google Cloud Armor security policy",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    {
      key: "type",
      label: "Policy Type",
      kind: "enum",
      required: false,
      enumValues: ["CLOUD_ARMOR", "CLOUD_ARMOR_EDGE", "CLOUD_ARMOR_NETWORK"],
    },
    { key: "ruleCount", label: "Rules", kind: "number", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};
