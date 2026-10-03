import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/organization/spend_alerts`, `POST/DELETE …/{alert_id}`, and
 * the project-scoped `…/projects/{project_id}/spend_alerts` equivalents:
 * verified 2026-10-03 against openapi.yaml. Admin key only.
 *
 * An email sent when monthly spend crosses a threshold. Unlike a spend
 * limit it never blocks requests. The API stores cents; fields are dollars.
 */
export const SpendAlertResourceType = rt({
  name: "Spend Alert",
  id: "spend-alert",
  description:
    "An email notification sent when the organization's or a project's monthly spend crosses a threshold. Requires an Admin API key.",
  fields: [
    f("scope", "Applies To", { editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("thresholdUsd", "Threshold (USD)", { kind: "number" }),
    f("recipients", "Recipients", {
      description: "Comma-separated email addresses that receive the alert.",
    }),
    f("subjectPrefix", "Subject Prefix", { required: false }),
    f("interval", "Interval", { required: false, editable: false }),
  ],
  outputs: [o("alertId", "Alert ID")],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "project", label: "watches" }],
  iconKey: "email",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});
