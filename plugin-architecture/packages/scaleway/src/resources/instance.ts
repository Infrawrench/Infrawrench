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
  // Sleep/wake schedules: serverAction poweron / poweroff. A powered-off
  // instance stops compute billing (volumes and reserved IPs keep billing).
  lifecycle: {
    startActionId: "poweron",
    stopActionId: "poweroff",
    statusFieldKey: "state",
    runningValues: ["running", "starting"],
    stoppedValues: ["stopped", "stopped in place", "stopping"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "state", value: "running" },
    defaultUsername: "root",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "root",
    defaultFields: {
      // The agents flow submits only these defaults; without a zone the
      // create call omits it and placement becomes nondeterministic.
      zone: "fr-par-1",
      commercialType: "DEV1-M",
      // Image label understood by createServer (and used as the image-picker
      // fallback id) — display names like "Ubuntu 24.04 Noble Numbat" are not
      // valid image ids/labels for the API.
      image: "ubuntu_noble",
    },
    linuxImageDefaults: { image: "ubuntu_noble" },
    hiddenFieldKeys: ["sshPublicKey"],
  },
  supportsCreate: true,
  supportsMetrics: true,
});
