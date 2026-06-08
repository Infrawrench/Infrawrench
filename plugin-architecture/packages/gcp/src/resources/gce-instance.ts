import { f, o, rt } from "@infrawrench/plugin-base";

export const GceInstanceResourceType = rt({
  name: "VM Instance",
  id: "gce-instance",
  description: "A Google Compute Engine virtual machine instance",
  fields: [
    f("name", "Name"),
    f("zone", "Zone"),
    f("machineType", "Machine Type"),
    f("status", "Status", { required: false }),
    f("networkTier", "Network Tier", { required: false }),
    f("network", "VPC Network", {
      kind: "association",
      required: false,
      description: "VPC network to attach the instance to",
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
  ],
  outputs: [o("externalIp", "External IP"), o("internalIp", "Internal IP")],
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "externalIp",
    privateHostOutputKey: "internalIp",
    runningWhen: { fieldKey: "status", value: "RUNNING" },
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
});
