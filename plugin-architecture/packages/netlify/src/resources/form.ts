import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NetlifyFormResourceType: ResourceTypeDefinition = {
  id: "netlify-form",
  displayName: "Form",
  pluralDisplayName: "Forms",
  description: "A Netlify form — collects submissions from static HTML forms",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "submissionCount", label: "Submissions", kind: "number", required: false },
    { key: "paths", label: "Paths", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
  ],
  outputs: [
    { key: "formId", label: "Form ID", sensitive: false },
    { key: "formName", label: "Form Name", sensitive: false },
  ],
  parentTypeId: "netlify-site",
  dashboardPinnable: false,
  iconKey: "form",
};
