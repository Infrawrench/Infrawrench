import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonBranchResourceType = rt({
  name: "Branch",
  plural: "Branches",
  id: "neon-branch",
  description: "A Neon branch — an isolated copy-on-write fork of your database",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID", { editable: false }),
    f("parentId", "Parent Branch", { required: false, editable: false }),
    f("primary", "Primary", { kind: "boolean", required: false, editable: false }),
    f("currentState", "State", { required: false, editable: false }),
    f("logicalSize", "Logical Size (bytes)", { kind: "number", required: false, editable: false }),
    f("initSource", "Created From", { required: false, editable: false }),
    f("lastResetAt", "Last Reset", { required: false, editable: false }),
    f("protected", "Protected", {
      kind: "boolean",
      required: false,
      description:
        "Protected branches can't be deleted or reset, and are covered by IP allow-lists set to protected branches only.",
    }),
    f("expiresAt", "Expires At", {
      required: false,
      description:
        "ISO 8601 time when Neon deletes the branch automatically (at most 30 days ahead). Blank removes the expiry.",
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [
    o("branchId", "Branch ID"),
    o("projectId", "Project ID"),
    o("connectionString", "Connection String (default database)", { sensitive: true }),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    // A branch's external id is its bare id, the same value `parentId` holds.
    { fieldKey: "parentId", targetTypeId: "neon-branch", label: "branched from" },
  ],
  expiryFields: [{ fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Branch expires" }],
  // Neon's `history_retention_seconds` (the PITR window that is the real
  // automated protection here) is not synced by any lister, so there is no
  // retention field to declare, only the presence of a snapshot is judged.
  backupPolicy: { protectedBy: ["neon-snapshot"] },
  parentTypeId: "neon-project",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "neon",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for the default database on this branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});
