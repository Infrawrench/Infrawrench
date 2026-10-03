import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One organization-level rate-limit group: a model family (e.g. "Claude
 * Sonnet 4.x") or an API surface such as the Message Batches API, the Files
 * API, Token Counting, Skills or the web search tool. Admin-key only and
 * read-only: Anthropic offers no endpoint to change limits, which are set by
 * usage tier (organization) or in the Console (workspace overrides).
 *
 * Docs: https://platform.claude.com/docs/en/manage-claude/rate-limits-api
 */
export const RateLimitResourceType = rt({
  name: "Rate Limit",
  id: "rate-limit",
  description:
    "An organization rate-limit group (a model family or an API surface) and its configured limits, such as requests, input tokens and output tokens per minute. Requires an Admin API key. Read-only.",
  fields: [
    f("groupName", "Group", { editable: false }),
    f("groupType", "Group Type", {
      kind: "enum",
      editable: false,
      enumValues: ["model_group", "batch", "files", "skills", "token_count", "web_search"],
    }),
    f("groupId", "Group ID", { required: false, editable: false }),
    f("models", "Models", { required: false, editable: false }),
    f("requestsPerMinute", "Requests / min", { kind: "number", required: false, editable: false }),
    f("inputTokensPerMinute", "Input tokens / min", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("outputTokensPerMinute", "Output tokens / min", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("limits", "All Limits", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID"), o("groupName", "Group")],
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "sliders",
});
