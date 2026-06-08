import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudRouterResourceType = rt({
  name: "Cloud Router",
  pinnable: false,
  id: "cloud-router",
  description: "A Google Cloud Router for dynamic routing and Cloud NAT",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("network", "VPC Network", {
      kind: "association",
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
    }),
    f("bgpAsn", "BGP ASN", { kind: "number", required: false }),
    f("natCount", "NAT Configs", { kind: "number", required: false }),
  ],
  outputs: [o("selfLink", "Self Link")],
  supportsCreate: true,
});
