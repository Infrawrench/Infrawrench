import { f, o, rt } from "@infrawrench/plugin-base";

export const HardwareResourceType = rt({
  name: "Hardware",
  id: "hardware",
  plural: "Hardware",
  description: "A hardware SKU a Replicate model or deployment can run on",
  fields: [f("sku", "SKU"), f("name", "Name")],
  outputs: [o("sku", "Hardware SKU")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "compute",
});
