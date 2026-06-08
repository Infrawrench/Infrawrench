import { f, o, rt } from "@infrawrench/plugin-base";

const ZONES = [
  "fr-par-1",
  "fr-par-2",
  "fr-par-3",
  "nl-ams-1",
  "nl-ams-2",
  "nl-ams-3",
  "pl-waw-1",
  "pl-waw-2",
  "pl-waw-3",
];

export const InstanceResourceType = rt({
  id: "instance",
  name: "Instance",
  plural: "Instances",
  description: "A Scaleway virtual machine",
  fields: [
    f("name", "Name"),
    f("zone", "Zone", { kind: "enum", enumValues: ZONES }),
    f("commercialType", "Commercial Type", {
      description: "Instance type, e.g. DEV1-S, GP1-S, PRO2-S",
    }),
    f("image", "Image", { description: "Image ID or name" }),
    f("state", "State", {
      kind: "enum",
      required: false,
      enumValues: ["running", "stopped", "stopped in place", "starting", "stopping"],
    }),
  ],
  outputs: [o("publicIp", "Public IP"), o("privateIp", "Private IP")],
  iconKey: "instance",
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "state", value: "running" },
    defaultUsername: "root",
  },
  supportsCreate: true,
  supportsMetrics: true,
});
