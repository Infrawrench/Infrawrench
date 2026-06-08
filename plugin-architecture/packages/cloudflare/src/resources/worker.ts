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
  ],
  outputs: [
    o("workerName", "Worker Name", {
      description: "Identifier used in `wrangler` commands and binding strings",
    }),
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "worker",
});
