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
    f("networkName", "Attached Network", {
      required: false,
      description: "Names of the VPC networks this instance's interfaces are attached to",
    }),
    f("subnetwork", "Subnet", {
      required: false,
      description: "Subnets this instance's interfaces sit in, as region/name",
    }),
    f("serviceAccounts", "Service Accounts", {
      required: false,
      description: "Emails of the service accounts attached to this instance",
    }),
  ],
  outputs: [o("externalIp", "External IP"), o("internalIp", "Internal IP")],
  // The lister reduces each selfLink to the form the target is keyed by:
  // networks are matched on their bare `name`, subnets on their `region/name`
  // external id (auto-mode VPCs put a `default` subnet in every region, so a
  // bare name resolves to nothing), service accounts on their email.
  dependsOn: [
    {
      fieldKey: "networkName",
      targetTypeId: "vpc-network",
      targetKey: "name",
      label: "in network",
    },
    { fieldKey: "subnetwork", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "serviceAccounts", targetTypeId: "gcp-service-account", label: "runs as" },
  ],
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "externalIp",
    privateHostOutputKey: "internalIp",
    runningWhen: { fieldKey: "status", value: "RUNNING" },
    usernameFieldKey: "sshUsername",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "ubuntu",
    defaultFields: {
      // The agents flow submits only these defaults, and the create handler
      // requires a zone — without one the request URL is malformed.
      zone: "us-central1-a",
      image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
      machineType: "e2-standard-2",
      diskGb: "40",
    },
    defaultFieldLabels: {
      zone: "Zone",
      image: "OS image",
      machineType: "Machine type",
      diskGb: "Boot disk size",
    },
    linuxImageDefaults: {
      image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
    },
    hiddenFieldKeys: ["sshPublicKey"],
  },
  supportsCreate: true,
});
