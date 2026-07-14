import { f, o, rt } from "@infrawrench/plugin-base";

export const ServerResourceType = rt({
  name: "Server",
  id: "server",
  description: "A Hetzner Cloud virtual machine",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "running",
        "initializing",
        "starting",
        "stopping",
        "off",
        "deleting",
        "migrating",
        "rebuilding",
        "unknown",
      ],
    }),
    f("serverType", "Server Type", { description: "Server type slug, e.g. cx22, cpx11, cax11" }),
    f("location", "Location", {
      kind: "enum",
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
    }),
    f("image", "Image", { description: "OS image name, e.g. ubuntu-24.04" }),
    f("datacenter", "Datacenter", {
      required: false,
      description: "Datacenter name, e.g. fsn1-dc14",
    }),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv6", "Public IPv6"), o("ipv4Private", "Private IPv4")],
  iconKey: "server",
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    runningWhen: { fieldKey: "status", value: "running" },
    defaultUsername: "root",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "root",
    defaultFields: {
      // The agents flow submits only these defaults; without a location the
      // create call omits it and placement becomes nondeterministic.
      location: "fsn1",
      serverType: "cx22",
      image: "ubuntu-24.04",
    },
    linuxImageDefaults: { image: "ubuntu-24.04" },
    hiddenFieldKeys: ["sshPublicKey"],
  },
  supportsCreate: true,
  supportsMetrics: true,
});
