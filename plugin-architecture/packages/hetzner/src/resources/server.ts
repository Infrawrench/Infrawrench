import { f, o, rt } from "@infrawrench/plugin-base";

export const ServerResourceType = rt({
  name: "Server",
  id: "server",
  description: "A Hetzner Cloud virtual machine",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      editable: false,
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
    f("serverType", "Server Type", {
      description:
        "Server type slug, e.g. cx22, cpx11, cax11. Changing it resizes the server (Hetzner change_type; requires the server to be powered off)",
    }),
    f("location", "Location", {
      kind: "enum",
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
      editable: false,
    }),
    f("image", "Image", {
      description: "OS image name, e.g. ubuntu-24.04",
      editable: false,
    }),
    f("datacenter", "Datacenter", {
      required: false,
      description: "Datacenter name, e.g. fsn1-dc14",
      editable: false,
    }),
    f("placementGroupId", "Placement Group", {
      required: false,
      description: "ID of the placement group this server is spread across, if any",
      editable: false,
    }),
    f("firewallIds", "Firewalls", {
      required: false,
      description: "Comma-separated IDs of the firewalls applied to the public interface",
      editable: false,
    }),
    f("networkIds", "Networks", {
      required: false,
      description: "Comma-separated IDs of the private networks this server is attached to",
      editable: false,
    }),
    f("primaryDiskGb", "Primary Disk (GB)", {
      kind: "number",
      required: false,
      description:
        "Actual root disk size. A type change keeps it (upgrade_disk=false), and the target type's included disk must be at least this big",
      editable: false,
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
  // Sleep/wake schedules: server actions poweron / poweroff. Note Hetzner
  // keeps billing a powered-off server (its resources stay reserved) — only
  // deleting it stops charges.
  lifecycle: {
    startActionId: "poweron",
    stopActionId: "poweroff",
    statusFieldKey: "status",
    runningValues: ["running", "starting"],
    stoppedValues: ["off", "stopping"],
  },
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
  // Edit = rename + change server type (the right-sizing apply path).
  supportsUpdate: true,
  supportsMetrics: true,
  // Right-sizing: the create form's size-picker is the real /server_types
  // catalog (capacity + per-location EUR prices); "CPU Utilization" is the
  // only utilisation series Hetzner's metrics API exposes — no memory metric
  // exists, so recommendations are CPU-driven with the host's memory floor.
  rightsizing: {
    sizeFieldKey: "serverType",
    regionFieldKey: "location",
    diskFieldKey: "primaryDiskGb",
    cpuMetric: { seriesLabel: "CPU Utilization" },
    priceCurrency: "EUR",
    // Letter prefix separates architectures/families: cx (x86 shared), cpx
    // (AMD shared), cax (arm), ccx (dedicated). Hetzner refuses cross-arch
    // type changes; staying inside one family is the conservative subset.
    sizeFamilyPattern: "^([a-z]+)",
    resizeNote:
      "Hetzner requires the server to be powered off before changing its type. The disk keeps its current size, so the change can be reverted.",
  },
  // Backups land in the `image` type carrying this server's id in `boundTo`.
  // Hetzner's `backup_window` on the server payload is not synced, so there is
  // no automated-backup field to declare — an unbacked server reads as
  // unprotected purely on the absence of a bound image, which is the honest
  // answer from what we have.
  backupPolicy: { protectedBy: ["image"] },
  // The lister always writes `firewallIds` ("" when none are attached), so
  // `equals ""` can't flag rows synced before the field existed.
  postureChecks: [
    {
      id: "hetzner-server-no-firewall",
      title: "No firewall attached",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "firewallIds", when: "equals", value: "" }],
      reason:
        "The server's public interface has no Hetzner Cloud firewall attached, so every listening port is reachable from the internet.",
    },
  ],
});
