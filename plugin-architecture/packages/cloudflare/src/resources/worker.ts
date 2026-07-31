import { f, o, rt } from "@infrawrench/plugin-base";

export const WorkerResourceType = rt({
  name: "Worker",
  id: "worker",
  description: "A Cloudflare Worker script",
  fields: [
    f("name", "Name"),
    f("createdOn", "Created", { required: false }),
    f("modifiedOn", "Modified", { required: false }),
    f("compatibilityDate", "Compat Date", { required: false }),
    f("routes", "Routes", { required: false }),
    f("tailConsumers", "Tail Consumers", { required: false }),
  ],
  outputs: [
    o("workerName", "Worker Name", {
      description: "Identifier used in `wrangler` commands and binding strings",
    }),
  ],
  // Tail consumers are named by script name, which is a Worker's external id.
  // The value is comma-joined, so each consumer becomes its own edge.
  dependsOn: [{ fieldKey: "tailConsumers", targetTypeId: "worker", label: "sends logs to" }],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "worker",
});
