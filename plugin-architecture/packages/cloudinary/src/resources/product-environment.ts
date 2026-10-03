import { f, o, rt } from "@infrawrench/plugin-base";

export const ProductEnvironmentResourceType = rt({
  name: "Product Environment",
  id: "product-environment",
  description:
    "The Cloudinary product environment itself: plan, credit and storage usage, folder mode and upload limits",
  fields: [
    f("cloudName", "Cloud Name"),
    f("plan", "Plan", { required: false }),
    f("folderMode", "Folder Mode", {
      kind: "enum",
      required: false,
      enumValues: ["dynamic", "fixed"],
    }),
    f("creditsUsed", "Credits Used", { kind: "number", required: false }),
    f("creditsLimit", "Credit Limit", { kind: "number", required: false }),
    f("creditsUsedPercent", "Credits Used (%)", { kind: "number", required: false }),
    f("storageBytes", "Storage (bytes)", { kind: "number", required: false }),
    f("bandwidthBytes", "Bandwidth (bytes)", { kind: "number", required: false }),
    f("transformations", "Transformations", { kind: "number", required: false }),
    f("assets", "Assets", { kind: "number", required: false }),
    f("derivedAssets", "Derived Assets", { kind: "number", required: false }),
    f("requests", "Requests", { kind: "number", required: false }),
    f("imageMaxBytes", "Max Image Size (bytes)", { kind: "number", required: false }),
    f("videoMaxBytes", "Max Video Size (bytes)", { kind: "number", required: false }),
    f("rawMaxBytes", "Max Raw File Size (bytes)", { kind: "number", required: false }),
    f("lastUpdated", "Usage Last Updated", { required: false }),
  ],
  outputs: [o("cloudName", "Cloud Name")],
  supportsDelete: false,
  // Daily usage history from `GET /usage?date=`.
  supportsMetrics: true,
  iconKey: "dashboard",
});
