import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AccessPolicyResourceType: ResourceTypeDefinition = {
  id: "access-policy",
  displayName: "Access Policy",
  pluralDisplayName: "Access Policies",
  description: "A policy within a Cloudflare Zero Trust Access application",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "decision", label: "Decision", kind: "string", required: true },
    { key: "precedence", label: "Precedence", kind: "number", required: false },
    { key: "includeRules", label: "Include Rules", kind: "string", required: false },
    { key: "excludeRules", label: "Exclude Rules", kind: "string", required: false },
    { key: "requireRules", label: "Require Rules", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "access-application",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "policy",
};
