import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST/DELETE /v1/organization/spend_limit` and
 * `GET/POST/DELETE /v1/organization/projects/{project_id}/spend_limit`:
 * verified 2026-10-03 against openapi.yaml. Admin key only.
 *
 * A hard monthly cap in USD: once spend reaches it, requests are refused
 * until the next month or until the limit is raised. One per organization
 * and at most one per project. The API stores cents; fields here are dollars.
 */
export const SpendLimitResourceType = rt({
  name: "Spend Limit",
  id: "spend-limit",
  description:
    "A hard monthly spend cap for the organization or one project. Requests are refused once spend reaches it. Requires an Admin API key.",
  fields: [
    f("scope", "Applies To", { editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("amountUsd", "Monthly Limit (USD)", {
      kind: "number",
      description: "Hard cap on spend per calendar month, in US dollars.",
    }),
    f("interval", "Interval", { required: false, editable: false }),
    f("enforcement", "Enforcement", { required: false, editable: false }),
  ],
  outputs: [o("amountUsd", "Monthly Limit (USD)")],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "project", label: "caps" }],
  iconKey: "sliders",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});
