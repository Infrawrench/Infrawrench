import { f, o, rt } from "@infrawrench/plugin-base";

export const CollectionResourceType = rt({
  name: "Collection",
  id: "collection",
  description: "A curated group of Replicate models, e.g. text-to-image or speech recognition",
  fields: [
    f("slug", "Slug"),
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("modelCount", "Models", { kind: "number", required: false }),
    f("models", "Model List", { required: false }),
  ],
  outputs: [o("slug", "Collection Slug"), o("collectionUrl", "Collection URL")],
  // Comma-joined `owner/name` references — one edge per member model.
  dependsOn: [{ fieldKey: "models", targetTypeId: "model", label: "contains" }],
  supportsDelete: false,
  pinnable: false,
  iconKey: "folder",
});
