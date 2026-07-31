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
    f("placementGroupId", "Placement Group", {
      required: false,
      description: "ID of the placement group this server is spread across, if any",
    }),
    f("firewallIds", "Firewalls", {
      required: false,
      description: "Comma-separated IDs of the firewalls applied to the public interface",
    }),
    f("networkIds", "Networks", {
      required: false,
      description: "Comma-separated IDs of the private networks this server is attached to",
    }),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv6", "Public IPv6"), o("ipv4Private", "Private IPv4")],
  // All three are ids straight off the /servers payload; each target type's
  // externalId is the same numeric id stringified.
  dependsOn: [
    { fieldKey: "placementGroupId", targetTypeId: "placement-group", label: "placed in" },
    { fieldKey: "firewallIds", targetTypeId: "firewall", label: "protected by" },
    { fieldKey: "networkIds", targetTypeId: "network", label: "attached to" },
  ],
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
