import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Deepgram project: the top-level billing/ownership container. Every key,
 * member, invite, balance and usage record hangs off a project.
 *
 * Docs: https://developers.deepgram.com/reference/management-api/projects/list
 */
export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A Deepgram project. Owns the API keys, members, invites, prepaid balances, Voice Agent configurations and usage for a workspace, and hosts the Speech playground and the request log.",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID", { required: false, editable: false }),
    // `mip_opt_out` only comes back from the single-project GET, not the list.
    f("mipOptOut", "Model Improvement Opt-Out", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("projectId", "Project ID", { description: "UUID used in every /v1/projects/{id} call." }),
    o("projectName", "Project Name"),
  ],
  supportsUpdate: true,
  // DELETE /v1/projects/{id}: permanent, and takes every key, member and
  // balance in the project with it.
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "project",
});
