import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET /v1/organization/projects/{project_id}/rate_limits` and
 * `POST …/rate_limits/{rate_limit_id}`: verified 2026-10-03 against
 * openapi.yaml (`list-project-rate-limits`, `update-project-rate-limits`).
 * Admin key only.
 *
 * One row per model per project. A project limit can only be lowered below
 * the organization's own limit for that model, never raised above it.
 */
export const ProjectRateLimitResourceType = rt({
  name: "Project Rate Limit",
  plural: "Project Rate Limits",
  id: "project-rate-limit",
  description:
    "A per-model rate limit on a project: requests and tokens per minute plus, where the model has them, images, audio, daily requests and batch tokens. Editable up to the organization's own limit. Requires an Admin API key.",
  fields: [
    f("model", "Model", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("projectName", "Project", { required: false, editable: false }),
    f("maxRequestsPerMinute", "Requests / min", { kind: "number" }),
    f("maxTokensPerMinute", "Tokens / min", { kind: "number" }),
    f("maxImagesPerMinute", "Images / min", { kind: "number", required: false }),
    f("maxAudioMegabytesPerMinute", "Audio MB / min", { kind: "number", required: false }),
    f("maxRequestsPerDay", "Requests / day", { kind: "number", required: false }),
    f("batchMaxInputTokensPerDay", "Batch input tokens / day", {
      kind: "number",
      required: false,
    }),
  ],
  outputs: [o("rateLimitId", "Rate Limit ID"), o("model", "Model")],
  dependsOn: [{ fieldKey: "model", targetTypeId: "model", label: "limits" }],
  parentTypeId: "project",
  iconKey: "sliders",
  supportsCreate: false,
  supportsUpdate: true,
  supportsDelete: false,
});
