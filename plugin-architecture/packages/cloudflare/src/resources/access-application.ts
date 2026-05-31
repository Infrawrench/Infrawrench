import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AccessApplicationResourceType: ResourceTypeDefinition = {
  id: "access-application",
  displayName: "Access Application",
  pluralDisplayName: "Access Applications",
  description: "A Cloudflare Zero Trust Access application",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "domain", label: "Domain", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false, editable: false },
    { key: "sessionDuration", label: "Session Duration", kind: "string", required: false },
    { key: "createdAt", label: "Created", kind: "string", required: false, editable: false },
    { key: "updatedAt", label: "Updated", kind: "string", required: false, editable: false },
  ],
  outputs: [
    {
      key: "aud",
      label: "Application AUD",
      sensitive: false,
      description: "The AUD tag for this Access application",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "access",
};
