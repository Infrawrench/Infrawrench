import { f, o, rt } from "@infrawrench/plugin-base";
import { REGION_IDS } from "../regions.js";

/**
 * A Linode (compute instance). `externalId` is the numeric Linode id.
 *
 * Billing facts the declarations below lean on (techdocs "Understanding
 * billing", verified 2026-10): a Linode is billed hourly up to its plan's
 * monthly cap whether it is running or powered off, and only deleting it
 * stops charges. Backups are a separate per-plan add-on.
 */
export const LinodeInstanceResourceType = rt({
  name: "Linode",
  id: "linode",
  description: "An Akamai Cloud (Linode) compute instance",
  fields: [
    f("label", "Label", {
      description: "3 to 64 characters: letters, digits, dashes, underscores and periods",
    }),
    f("status", "Status", {
      editable: false,
      required: false,
      kind: "enum",
      enumValues: [
        "running",
        "offline",
        "booting",
        "busy",
        "rebooting",
        "shutting_down",
        "provisioning",
        "deleting",
        "migrating",
        "rebuilding",
        "cloning",
        "restoring",
        "stopped",
        "billing_suspension",
      ],
    }),
    f("type", "Plan", {
      description:
        "Linode plan, e.g. g6-standard-2. Changing it resizes the Linode: it is powered off, migrated to the new plan and booted again",
    }),
    f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false }),
    f("image", "Image", { required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("diskGb", "Disk (GB)", { kind: "number", required: false, editable: false }),
    f("backupsEnabled", "Backups", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "Whether the Linode Backups add-on is enabled",
    }),
    f("lastBackup", "Last Successful Backup", { required: false, editable: false }),
    f("lkeClusterId", "Kubernetes Cluster", {
      required: false,
      editable: false,
      description: "ID of the LKE cluster this Linode is a worker node of, if any",
    }),
    f("firewallIds", "Firewalls", {
      required: false,
      editable: false,
      description: "Comma-separated IDs of the Cloud Firewalls protecting this Linode",
    }),
    f("placementGroup", "Placement Group", { required: false, editable: false }),
    f("watchdogEnabled", "Shutdown Watchdog", {
      kind: "boolean",
      required: false,
      description: "Lassie reboots the Linode if it powers off unexpectedly",
    }),
    f("tags", "Tags", { required: false, description: "Comma-separated tags" }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("ipv4", "Public IPv4"),
    o("ipv4Private", "Private IPv4"),
    o("ipv6", "IPv6"),
    o("linodeId", "Linode ID", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "lkeClusterId", targetTypeId: "lke-cluster", label: "node of" },
    { fieldKey: "firewallIds", targetTypeId: "firewall", label: "protected by" },
  ],
  iconKey: "server",
  supportsCreate: true,
  // Edit = label, tags, watchdog, and plan (the right-sizing apply path).
  supportsUpdate: true,
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    runningWhen: { fieldKey: "status", value: "running" },
    defaultUsername: "root",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "root",
    defaultFields: { region: "us-east", type: "g6-standard-2", image: "linode/ubuntu24.04" },
    linuxImageDefaults: { image: "linode/ubuntu24.04" },
    hiddenFieldKeys: ["sshPublicKey", "rootPass"],
  },
  // Sleep/wake schedules: boot and the ACPI shutdown. Linode keeps billing a
  // powered-off Linode, so a schedule saves nothing here; the declaration is
  // still useful for the power controls themselves.
  lifecycle: {
    startActionId: "boot",
    stopActionId: "shutdown",
    statusFieldKey: "status",
    runningValues: ["running", "booting", "rebooting"],
    stoppedValues: ["offline", "shutting_down", "stopped"],
  },
  // CPU-only: the stats endpoint has no memory series. No disk guard: a
  // resize to a smaller plan shrinks the disk automatically when the data
  // fits (`allow_auto_disk_resize`), so the plan's disk size is not a floor.
  rightsizing: {
    sizeFieldKey: "type",
    regionFieldKey: "region",
    cpuMetric: { seriesLabel: "CPU Utilization" },
    // g6-standard-2 / g7-highmem-1 / g6-dedicated-8: the class after the
    // generation is the family. Staying inside it keeps shared on shared and
    // dedicated on dedicated.
    sizeFamilyPattern: "^g\\d+-([a-z]+)",
    resizeNote:
      "Linode powers the instance off, migrates it to the new plan and boots it again. Moving to a smaller plan only works when the data fits on the smaller disk; Linode shrinks the disk automatically.",
  },
  // The lister always writes `status` and `lkeClusterId` ("" for a Linode
  // outside LKE): worker nodes are the node pool's business, not this rule's.
  orphanRule: {
    conditions: [
      { fieldKey: "status", when: "equals", value: "offline" },
      { fieldKey: "lkeClusterId", when: "equals", value: "" },
    ],
    reason:
      "Linode is powered off but still billed at its full plan rate; only deleting it stops the charges",
  },
  // Private images record no source Linode, so only the Backups add-on
  // counts as protection.
  backupPolicy: {
    protectedBy: [],
    automatedBackupFieldKey: "backupsEnabled",
  },
  postureChecks: [
    {
      id: "linode-no-firewall",
      title: "No Cloud Firewall",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "firewallIds", when: "equals", value: "" },
        { fieldKey: "lkeClusterId", when: "equals", value: "" },
      ],
      reason:
        "No Cloud Firewall is attached, so every port the Linode listens on is reachable from the internet.",
    },
    {
      id: "linode-backups-disabled",
      title: "Backups disabled",
      severity: "low",
      category: "data-protection",
      conditions: [
        { fieldKey: "backupsEnabled", when: "falsy" },
        { fieldKey: "lkeClusterId", when: "equals", value: "" },
      ],
      reason: "The Linode Backups add-on is off, so recovery depends entirely on manual images.",
    },
  ],
});

/** A private (account-owned) image. `externalId` is the image id, e.g. `private/123`. */
export const ImageResourceType = rt({
  name: "Image",
  id: "image",
  description: "A private Linode image captured from a disk or uploaded",
  fields: [
    f("label", "Label"),
    f("description", "Description", { required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("type", "Type", {
      required: false,
      editable: false,
      description:
        "manual images are captured on request; automatic ones are kept for 7 days after a Linode is deleted",
    }),
    f("sizeMb", "Size (MB)", { kind: "number", required: false, editable: false }),
    f("totalSizeBytes", "Billed Size (bytes)", {
      kind: "number",
      required: false,
      editable: false,
      description: "Total stored across every region the image is replicated to",
    }),
    f("regions", "Regions", { required: false, editable: false }),
    f("cloudInit", "cloud-init", { kind: "boolean", required: false, editable: false }),
    f("expiry", "Expires", { required: false, editable: false }),
    f("tags", "Tags", { required: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("imageId", "Image ID")],
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
  expiryFields: [
    { fieldKey: "expiry", from: "expiry", kind: "other", label: "Automatic image expiry" },
  ],
});

/** A StackScript the account owns. `externalId` is the numeric id. */
export const StackScriptResourceType = rt({
  name: "StackScript",
  id: "stackscript",
  description: "A reusable deployment script for new Linodes",
  fields: [
    f("label", "Label"),
    f("description", "Description", { required: false }),
    f("images", "Compatible Images", {
      description:
        "Comma-separated image IDs this script can deploy, e.g. linode/ubuntu24.04, or any/all",
    }),
    f("script", "Script", {
      description: "Must start with a shebang, e.g. #!/bin/bash",
    }),
    f("revNote", "Revision Note", { required: false }),
    f("isPublic", "Public", {
      kind: "boolean",
      required: false,
      description: "Public StackScripts can be used by anyone and cannot be made private again",
    }),
    f("deploymentsActive", "Active Deployments", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("deploymentsTotal", "Total Deployments", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("updated", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("stackscriptId", "StackScript ID")],
  pinnable: false,
  iconKey: "code",
  supportsCreate: true,
  supportsUpdate: true,
});
