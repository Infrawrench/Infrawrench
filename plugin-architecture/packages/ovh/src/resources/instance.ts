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
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv6", "Public IPv6"), o("ipv4Private", "Private IPv4")],
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
