import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudRunServiceResourceType: ResourceTypeDefinition = {
  id: "cloud-run-service",
  displayName: "Cloud Run Service",
  pluralDisplayName: "Cloud Run Services",
  description: "A Google Cloud Run managed service",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "latestRevision", label: "Latest Revision", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "ingress", label: "Ingress", kind: "string", required: false },
    {
      key: "network",
      label: "VPC Network",
      kind: "association",
      required: false,
      description: "VPC network for private service access",
      allowLiteral: true,
      resolvableOutputKeys: ["selfLink"],
      resolvableFrom: [
        {
          pluginId: "gcp",
          resourceTypeId: "vpc-network",
          outputKey: "selfLink",
        },
      ],
    },
  ],
  outputs: [{ key: "url", label: "Service URL", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
};
