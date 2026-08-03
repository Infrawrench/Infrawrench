import { f, o, rt } from "@infrawrench/plugin-base";

export const DropletResourceType = rt({
  name: "Droplet",
  id: "droplet",
  description: "A DigitalOcean virtual machine",
  fields: [
    f("name", "Name"),
    f("region", "Region", {
      editable: false,
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
    f("size", "Size", {
      description:
        "Droplet size slug, e.g. s-1vcpu-1gb. Changing it resizes the Droplet (CPU/RAM-only resize; DO powers it off for the change)",
    }),
    f("image", "Image", {
      description: "Image slug or ID, e.g. ubuntu-24-04-x64",
      editable: false,
    }),
    f("vpcUuid", "VPC", {
      required: false,
      description: "UUID of the VPC network this Droplet is attached to",
      editable: false,
    }),
    f("status", "Status", { required: false, editable: false }),
    f("diskGb", "Disk (GB)", {
      kind: "number",
      required: false,
      description:
        "Actual disk size. A CPU/RAM-only resize keeps it, and the target size's included disk must be at least this big",
      editable: false,
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
  // Edit = rename + resize (the right-sizing apply path).
  supportsUpdate: true,
  // Right-sizing: /v2/sizes is the real catalog (capacity + USD prices +
  // per-region availability). CPU is always reported; the memory series only
  // exists on Droplets running the DO Metrics Agent — without it,
  // recommendations fall back to the host's unmeasured-memory floor.
  rightsizing: {
    sizeFieldKey: "size",
    regionFieldKey: "region",
    diskFieldKey: "diskGb",
    cpuMetric: { seriesLabel: "CPU Utilization" },
    memoryMetric: { seriesLabel: "Memory Available", interpretation: "available-bytes" },
    // Slug prefix before the first dash is the family (s-, c-, c2-, m3-,
    // so1_5-, …) — staying inside it keeps the resize like-for-like.
    sizeFamilyPattern: "^([a-z0-9_]+)-",
    resizeNote:
      "DigitalOcean powers the Droplet off for the resize and boots it again afterwards. CPU/RAM only — the disk is unchanged, so the change can be reverted.",
  },
});
