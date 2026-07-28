import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Deepgram project — the top-level billing/ownership container. Every key,
 * member, invite, balance and usage record hangs off a project.
 *
 * Docs: https://developers.deepgram.com/reference/management-api/projects/list
 */
export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A Deepgram project. Owns the API keys, members, invites, prepaid balances and usage for a workspace, and hosts the Speech playground for transcription and text-to-speech.",
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
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "project",
});
