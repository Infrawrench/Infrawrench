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
  // `<script>.<account-subdomain>.workers.dev`. Deleting the script frees the
  // name inside the account subdomain, which anyone with a Worker in that
  // account can then take.
  dnsServiceHosts: [
    {
      id: "workers-dev",
      label: "workers.dev subdomain",
      hostPattern: String.raw`([a-z0-9][a-z0-9-]*)\.[a-z0-9-]+\.workers\.dev`,
      reason:
        "The name is free for anyone who can deploy a Worker on that account subdomain to claim, and Cloudflare will serve their script under your hostname.",
    },
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "worker",
});
