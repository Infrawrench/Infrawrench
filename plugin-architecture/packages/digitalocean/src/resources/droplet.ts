import { f, o, rt } from "@infrawrench/plugin-base";

export const DropletResourceType = rt({
  name: "Droplet",
  id: "droplet",
  description: "A DigitalOcean virtual machine",
  fields: [
    f("name", "Name"),
    f("region", "Region", {
      kind: "enum",
      enumValues: [
        "nyc1",
        "nyc3",
        "sfo2",
        "sfo3",
        "ams3",
        "fra1",
        "sgp1",
        "lon1",
        "tor1",
        "blr1",
        "syd1",
      ],
    }),
    f("size", "Size", { description: "Droplet size slug, e.g. s-1vcpu-1gb" }),
    f("image", "Image", { description: "Image slug or ID, e.g. ubuntu-24-04-x64" }),
    f("vpcUuid", "VPC", {
      required: false,
      description: "UUID of the VPC network this Droplet is attached to",
    }),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv4Private", "Private IPv4"), o("ipv6", "Public IPv6")],
  // The lister records `vpc_uuid`; a VPC's externalId is that same uuid.
  dependsOn: [{ fieldKey: "vpcUuid", targetTypeId: "vpc", label: "in VPC" }],
  parentTypeId: "project",
  showInSidebar: true,
  supportsMetrics: true,
  iconKey: "droplet",
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    defaultUsername: "root",
    runningWhen: { fieldKey: "status", value: "active" },
  },
  // Sleep/wake schedules: the existing droplet power actions. Stop is the
  // hard power_off rather than the ACPI shutdown — a scheduled sleep must not
  // depend on the guest OS honouring the event. (DO bills stopped droplets;
  // the savings quote is an upper bound for this provider.)
  lifecycle: {
    startActionId: "power_on",
    stopActionId: "power_off",
    statusFieldKey: "status",
    runningValues: ["active"],
    stoppedValues: ["off"],
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "root",
    defaultFields: {
      // The agents flow submits only these defaults; without a region the
      // create call omits it and placement becomes nondeterministic.
      region: "nyc3",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
    },
    linuxImageDefaults: { image: "ubuntu-24-04-x64" },
    hiddenFieldKeys: ["sshPublicKey"],
  },
  supportsCreate: true,
});
