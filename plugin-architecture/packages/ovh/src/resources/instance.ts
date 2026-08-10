import { f, o, rt } from "@infrawrench/plugin-base";

const REGIONS = [
  "GRA1",
  "GRA3",
  "GRA5",
  "GRA7",
  "GRA9",
  "GRA11",
  "SBG5",
  "BHS5",
  "WAW1",
  "DE1",
  "UK1",
  "SGP1",
  "SYD1",
];

export const InstanceResourceType = rt({
  id: "instance",
  name: "Instance",
  plural: "Instances",
  description: "An OVHcloud Public Cloud virtual machine",
  fields: [
    f("name", "Name"),
    f("region", "Region", { kind: "enum", enumValues: REGIONS }),
    f("flavorName", "Flavor", { description: "Instance flavor name, e.g. b2-7" }),
    f("imageName", "Image", { description: "OS image name, e.g. Ubuntu 24.04" }),
    f("status", "Status", { required: false }),
    f("networkIds", "Networks", {
      required: false,
      description:
        "Comma-separated IDs of the networks this instance has an address on. Public addresses reference the shared Ext-Net, private ones a private network.",
    }),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv6", "Public IPv6"), o("ipv4Private", "Private IPv4")],
  // `ipAddresses[].networkId` (`cloud.instance.IpAddress` in
  // https://eu.api.ovh.com/1.0/cloud.json) holds the project-level `pn-…` id,
  // which is this plugin's `private-network.externalId` — so the default
  // `targetKey` is the match, not `openstackIds`. Verified against OVH's own
  // control panel, which pairs the two by that id in both places it does so:
  // `instances.service.js` filters `/network/private` entries whose `id`
  // appears in the instance's private `ipAddresses[].networkId`, and
  // pci-public-ip's `useInstance.ts` compares `ipAddress.networkId` to the
  // `network.id` returned by `getPrivateNetworkIdFromGateway`. The Ext-Net id
  // carried by public addresses names no listed resource, so it matches
  // nothing.
  dependsOn: [{ fieldKey: "networkIds", targetTypeId: "private-network", label: "attached to" }],
  iconKey: "instance",
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    runningWhen: { fieldKey: "status", value: "ACTIVE" },
    defaultUsername: "root",
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
});
