import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudRouterResourceType: ResourceTypeDefinition = {
  id: "cloud-router",
  displayName: "Cloud Router",
  pluralDisplayName: "Cloud Routers",
  description: "A Google Cloud Router for dynamic routing and Cloud NAT",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    {
      key: "network",
      label: "VPC Network",
      kind: "association",
      required: true,
      description: "VPC network the router attaches to",
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
    { key: "bgpAsn", label: "BGP ASN", kind: "number", required: false },
    { key: "natCount", label: "NAT Configs", kind: "number", required: false },
  ],
  outputs: [{ key: "selfLink", label: "Self Link", sensitive: false }],
  dashboardPinnable: false,
  supportsCreate: true,
};
