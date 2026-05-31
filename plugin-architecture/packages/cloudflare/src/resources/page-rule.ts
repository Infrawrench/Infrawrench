import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PageRuleResourceType: ResourceTypeDefinition = {
  id: "page-rule",
  displayName: "Page Rule",
  pluralDisplayName: "Page Rules",
  description: "A Cloudflare Page Rule for URL-based settings",
  fields: [
    { key: "targets", label: "URL Pattern", kind: "string", required: true, editable: false },
    { key: "actions", label: "Actions", kind: "string", required: false, editable: false },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "priority", label: "Priority", kind: "number", required: false },
    { key: "createdOn", label: "Created", kind: "string", required: false, editable: false },
    { key: "modifiedOn", label: "Modified", kind: "string", required: false, editable: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "rule",
};
