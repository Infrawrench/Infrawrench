import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonSnapshotResourceType = rt({
  name: "Snapshot",
  plural: "Snapshots",
  id: "neon-snapshot",
  description: "A point-in-time snapshot of a Neon branch, restorable into a new branch",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID"),
    f("sourceBranchId", "Source Branch", { required: false }),
    f("manual", "Manual", { kind: "boolean", required: false }),
    f("size", "Size", { required: false }),
    f("lsn", "LSN", { required: false }),
    f("timestamp", "Timestamp", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
  ],
  outputs: [o("snapshotId", "Snapshot ID"), o("projectId", "Project ID")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "sourceBranchId", targetTypeId: "neon-branch", label: "taken from branch" },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Snapshot expires" },
  ],
  // A branch's external id is `{projectId}/{branchId}` while `sourceBranchId`
  // is bare — the same composition `ps-backup` needs, for the same reason.
  // `size` is deliberately not declared: the lister stores a pre-formatted
  // human string ("1.2 GB"), and reading it as a number would understate the
  // orphan total by orders of magnitude.
  backupRole: {
    role: "snapshot",
    sourceTemplate: "{projectId}/{sourceBranchId}",
    createdKey: "createdAt",
  },
  parentTypeId: "neon-branch",
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "volume",
});
