import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AppEngineServiceResourceType: ResourceTypeDefinition = {
  id: "app-engine-service",
  displayName: "App Engine Service",
  pluralDisplayName: "App Engine Services",
  description: "A Google App Engine service",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "servingStatus", label: "Serving Status", kind: "string", required: false },
    { key: "latestVersion", label: "Latest Version", kind: "string", required: false },
    { key: "trafficSplit", label: "Traffic Split", kind: "string", required: false },
  ],
  outputs: [{ key: "url", label: "Service URL", sensitive: false }],
  dashboardPinnable: true,
};
