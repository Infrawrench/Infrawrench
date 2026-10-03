import { f, o, rt } from "@infrawrench/plugin-base";

export const StorageBoxResourceType = rt({
  name: "Storage Box",
  id: "storage-box",
  description:
    "A Hetzner Storage Box: network storage reachable over SFTP, SCP, rsync, Samba and WebDAV",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["active", "initializing", "locked"],
      editable: false,
    }),
    f("storageBoxType", "Type", {
      description:
        "Storage Box type, e.g. bx11, bx21. Changing it resizes the box (Hetzner change_type)",
    }),
    f("location", "Location", { required: false, editable: false }),
    f("username", "Username", { required: false, editable: false }),
    f("server", "Server", { required: false, editable: false }),
    f("sizeGb", "Capacity (GB)", { kind: "number", required: false, editable: false }),
    f("usedGb", "Used (GB)", { kind: "number", required: false, editable: false }),
    f("snapshotsGb", "Snapshots (GB)", { kind: "number", required: false, editable: false }),
    f("sshEnabled", "SSH", { kind: "boolean", required: false }),
    f("sambaEnabled", "Samba", { kind: "boolean", required: false }),
    f("webdavEnabled", "WebDAV", { kind: "boolean", required: false }),
    f("zfsEnabled", "ZFS Snapshot Folder", { kind: "boolean", required: false }),
    f("reachableExternally", "Reachable Externally", {
      kind: "boolean",
      required: false,
      description: "When off, only Hetzner servers can reach the box",
    }),
    f("snapshotPlan", "Snapshot Plan", {
      required: false,
      description: "Automatic snapshot schedule, if one is enabled",
      editable: false,
    }),
    f("deleteProtection", "Delete Protection", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("server", "Server"), o("username", "Username")],
  supportsCreate: true,
  // Edit = rename, resize (`change_type`) and the access toggles
  // (`update_access_settings`).
  supportsUpdate: true,
  iconKey: "storage",
  postureChecks: [
    {
      id: "hetzner-storage-box-samba-external",
      title: "Samba reachable from the internet",
      severity: "medium",
      category: "public-exposure",
      conditions: [
        { fieldKey: "sambaEnabled", when: "truthy" },
        { fieldKey: "reachableExternally", when: "truthy" },
      ],
      reason:
        "Samba/CIFS is enabled and the box accepts connections from outside Hetzner's network.",
    },
  ],
});
