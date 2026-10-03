import { f, o, rt } from "@infrawrench/plugin-base";

export const InstanceResourceType = rt({
  id: "instance",
  name: "Instance",
  plural: "Instances",
  description: "An OVHcloud Public Cloud virtual machine",
  fields: [
    f("name", "Name"),
    f("region", "Region", {
      description: "OpenStack region, e.g. GRA11, EU-WEST-PAR",
      editable: false,
    }),
    f("flavorName", "Flavor", {
      description:
        "Instance flavor name, e.g. b3-8. Changing it resizes the instance (OVH can only resize to a flavor with an equal or larger disk)",
    }),
    f("imageName", "Image", { description: "OS image name, e.g. Ubuntu 24.04", editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("monthlyBilling", "Monthly Billing", {
      kind: "boolean",
      required: false,
      description: "Billed at the monthly rate instead of hourly",
      editable: false,
    }),
    f("outgoingTrafficGb", "Outgoing Traffic This Month (GB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("networkIds", "Networks", {
      required: false,
      description:
        "Comma-separated IDs of the networks this instance has an address on. Public addresses reference the shared Ext-Net, private ones a private network.",
      editable: false,
    }),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv6", "Public IPv6"), o("ipv4Private", "Private IPv4")],
  // `ipAddresses[].networkId` (`cloud.instance.IpAddress` in
  // https://eu.api.ovh.com/1.0/cloud.json) holds the project-level `pn-…` id,
  // which is this plugin's `private-network.externalId`, so the default
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
  // Sleep/wake schedules: `start` / `stop`. OVH keeps billing a stopped
  // instance at the full rate; only shelving (a separate action) stops the
  // compute charge.
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["ACTIVE"],
    stoppedValues: ["SHUTOFF", "STOPPED", "SHELVED", "SHELVED_OFFLOADED"],
  },
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    runningWhen: { fieldKey: "status", value: "ACTIVE" },
    defaultUsername: "root",
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
  // Edit = rename (`PUT /instance/{id}`) and resize (`POST /instance/{id}/resize`).
  supportsUpdate: true,
});
