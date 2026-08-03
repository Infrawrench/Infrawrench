import { f, o, rt } from "@infrawrench/plugin-base";

export const GceInstanceResourceType = rt({
  name: "VM Instance",
  id: "gce-instance",
  description: "A Google Compute Engine virtual machine instance",
  fields: [
    // GCE instance names are immutable; the only editable field is
    // machineType (the right-sizing resize path).
    f("name", "Name", { editable: false }),
    f("zone", "Zone", { editable: false }),
    f("machineType", "Machine Type", {
      description:
        "Machine type name, e.g. e2-standard-2. Changing it resizes the instance (only allowed while it is stopped)",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("osFamily", "OS Family", {
      required: false,
      description:
        'Derived from the boot disk\'s license URIs: "windows" or "linux". Gates the RDP button.',
      editable: false,
    }),
    f("networkTier", "Network Tier", { required: false, editable: false }),
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
      editable: false,
    }),
    f("subnetwork", "Subnet", {
      required: false,
      description: "Subnets this instance's interfaces sit in, as region/name",
      editable: false,
    }),
    f("serviceAccounts", "Service Accounts", {
      required: false,
      description: "Emails of the service accounts attached to this instance",
      editable: false,
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
  // Sleep/wake schedules: instances.stop / instances.start. A TERMINATED VM
  // stops compute billing (disks and reserved IPs keep billing).
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["RUNNING", "PROVISIONING", "STAGING"],
    stoppedValues: ["TERMINATED", "STOPPING", "SUSPENDED"],
  },
  sshEndpoint: {
    hostOutputKey: "externalIp",
    privateHostOutputKey: "internalIp",
    runningWhen: { fieldKey: "status", value: "RUNNING" },
    usernameFieldKey: "sshUsername",
  },
  rdpEndpoint: {
    hostOutputKey: "externalIp",
    privateHostOutputKey: "internalIp",
    runningWhen: { fieldKey: "status", value: "RUNNING" },
    windowsWhen: { fieldKey: "osFamily", value: "windows" },
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
  // Edit = change machine type only (GCE instance names are immutable).
  supportsUpdate: true,
  // Right-sizing: the create form's machineTypes catalog carries capacity;
  // prices hydrate through getCreateSizePricing (Cloud Billing catalog, per
  // geo). GCE's cpu/utilization series is a 0–1 fraction; no agentless
  // memory metric exists, so the host's unmeasured-memory floor applies.
  rightsizing: {
    sizeFieldKey: "machineType",
    regionFieldKey: "zone",
    cpuMetric: { seriesLabel: "CPU Utilization", scale: "fraction" },
    // Family prefix before the first dash (e2, n2, t2a, c3…) — keeps arm
    // (t2a) and generation jumps out, which setMachineType can't cross.
    sizeFamilyPattern: "^([a-z0-9]+)-",
    resizeNote:
      "Google Compute Engine only changes the machine type of a stopped instance — stop it first, apply the resize, then start it again.",
  },
});
