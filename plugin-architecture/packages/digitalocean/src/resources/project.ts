import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ProjectResourceType: ResourceTypeDefinition = {
  id: "project",
  displayName: "Project",
  pluralDisplayName: "Projects",
  description: "A DigitalOcean Project — groups related resources",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "purpose",
      label: "Purpose",
      kind: "enum",
      required: false,
      enumValues: ["Web Application", "API", "Mobile Application", "Website", "CI/CD", "Other"],
    },
    { key: "description", label: "Description", kind: "string", required: false },
    {
      key: "environment",
      label: "Environment",
      kind: "enum",
      required: false,
      enumValues: ["Development", "Staging", "Production"],
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "project",
};
