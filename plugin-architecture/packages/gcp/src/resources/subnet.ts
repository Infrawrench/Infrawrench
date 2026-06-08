import { f, o, rt } from "@infrawrench/plugin-base";

export const SubnetResourceType = rt({
  name: "Subnet",
  pinnable: false,
  id: "subnet",
  description: "A Google Cloud VPC subnetwork",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("network", "Network", { required: false }),
    f("ipCidrRange", "IP CIDR Range"),
    f("gatewayAddress", "Gateway", { required: false }),
    f("privateIpGoogleAccess", "Private Google Access", { kind: "boolean", required: false }),
    f("purpose", "Purpose", { required: false }),
    f("stackType", "Stack Type", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
