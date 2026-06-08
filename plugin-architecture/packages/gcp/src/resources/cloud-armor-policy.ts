import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudArmorPolicyResourceType = rt({
  name: "Cloud Armor Policy",
  plural: "Cloud Armor Policies",
  pinnable: false,
  id: "cloud-armor-policy",
  description: "A Google Cloud Armor security policy",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Policy Type", {
      kind: "enum",
      required: false,
      enumValues: ["CLOUD_ARMOR", "CLOUD_ARMOR_EDGE", "CLOUD_ARMOR_NETWORK"],
    }),
    f("ruleCount", "Rules", { kind: "number", required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
