import { f, rt } from "@infrawrench/plugin-base";

export const CloudArmorPolicyResourceType = rt({
  name: "Cloud Armor Policy",
  plural: "Cloud Armor Policies",
  pinnable: false,
  id: "cloud-armor-policy",
  iconKey: "shield",
  description: "A Google Cloud Armor security policy",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Policy Type", {
      showcase: true,
      kind: "enum",
      required: false,
      enumValues: ["CLOUD_ARMOR", "CLOUD_ARMOR_EDGE", "CLOUD_ARMOR_NETWORK"],
    }),
    f("ruleCount", "Rules", { showcase: true, kind: "number", required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
