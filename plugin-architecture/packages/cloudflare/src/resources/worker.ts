import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const WorkerResourceType: ResourceTypeDefinition = {
  id: "worker",
  displayName: "Worker",
  pluralDisplayName: "Workers",
  description: "A Cloudflare Worker script",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "createdOn", label: "Created", kind: "string", required: false },
    { key: "modifiedOn", label: "Modified", kind: "string", required: false },
    { key: "compatibilityDate", label: "Compat Date", kind: "string", required: false },
    { key: "routes", label: "Routes", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  iconKey: "worker",
};
