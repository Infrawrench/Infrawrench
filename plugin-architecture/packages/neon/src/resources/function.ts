import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Functions have no JSON create endpoint — a function comes into existence via a
 * multipart zip deployment, which is driven from the `neon.ts` config and CLI.
 * The plugin therefore lists, renames, and deletes them, but does not create them.
 */
export const NeonFunctionResourceType = rt({
  name: "Function",
  plural: "Functions",
  id: "neon-function",
  description: "A Neon Function — Node.js compute deployed next to a branch's database",
  fields: [
    f("name", "Name"),
    f("slug", "Slug"),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("invocationUrl", "Invocation URL", { required: false }),
    f("deploymentStatus", "Deployment Status", { required: false }),
    f("runtime", "Runtime", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("invocationUrl", "Invocation URL"), o("functionId", "Function ID")],
  parentTypeId: "neon-branch",
  supportsDelete: true,
  iconKey: "function",
});
