import { f, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean Droplet autoscale pool (`/v2/droplets/autoscale`): a group of
 * identical Droplets DO grows and shrinks between `minInstances` and
 * `maxInstances` to hold target CPU/memory utilisation, or holds at a fixed
 * count. The members are ordinary Droplets and list under Droplets too.
 *
 * Shape verified against digitalocean/openapi
 * (`specification/resources/autoscale_pools/models/autoscale_pool.yml`).
 */
export const AutoscalePoolResourceType = rt({
  name: "Autoscale Pool",
  id: "autoscale-pool",
  description: "A DigitalOcean Droplet autoscale pool.",
  fields: [
    f("name", "Name", { editable: false, description: "Fixed at creation." }),
    f("status", "Status", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("size", "Droplet Size", { required: false, editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("mode", "Scaling", {
      kind: "enum",
      required: false,
      enumValues: ["dynamic", "static"],
      description: "dynamic scales on utilisation; static holds a fixed Droplet count.",
    }),
    f("targetNumberInstances", "Fixed Droplet Count", {
      kind: "number",
      required: false,
      description: "Static pools only: the number of Droplets to keep (1-1000).",
    }),
    f("minInstances", "Min Droplets", {
      kind: "number",
      required: false,
      description: "Dynamic pools only (1-500).",
    }),
    f("maxInstances", "Max Droplets", {
      kind: "number",
      required: false,
      description: "Dynamic pools only (1-1000).",
    }),
    f("targetCpuUtilization", "Target CPU (%)", {
      kind: "number",
      required: false,
      description:
        "Dynamic pools: scale to hold this average CPU, 5-100. Leave blank to ignore CPU.",
    }),
    f("targetMemoryUtilization", "Target Memory (%)", {
      kind: "number",
      required: false,
      description:
        "Dynamic pools: scale to hold this average memory, 5-100. Leave blank to ignore memory.",
    }),
    f("cooldownMinutes", "Cooldown (min)", {
      kind: "number",
      required: false,
      description: "Minutes between scaling events, 5-20.",
    }),
    f("activeResourcesCount", "Active Droplets", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("vpcUuid", "VPC", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "vpcUuid", targetTypeId: "vpc", label: "in VPC" }],
  showInSidebar: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "scaling",
});
