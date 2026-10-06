import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** API key scopes (the OAuth scopes in the OpenAPI document, plus `org:delete` from the key docs). */
export const API_KEY_SCOPES = [
  "org:read",
  "org:write",
  "org:delete",
  "role:read",
  "role:write",
  "keys:read",
  "keys:write",
  "project:read",
  "project:write",
  "branch:read",
  "branch:write",
  "metrics:read",
  "logs:read",
  "credentials:read",
  "credentials:write",
];

const ro = { required: false, editable: false } as const;

export const OrganizationType = rt({
  name: "Organization",
  id: "xata-organization",
  description: "A Xata organization: billing, members, API keys and limits",
  fields: [
    f("name", "Name", { description: "Display name of the organization." }),
    f("organizationId", "Organization ID", { editable: false }),
    f("status", "Status", ro),
    f("billingStatus", "Billing Status", ro),
    f("billingReason", "Billing Note", ro),
    f("usageTier", "Usage Tier", ro),
    f("marketplace", "Billed Through", ro),
    f("memberCount", "Members", { kind: "number", ...ro }),
    f("createdAt", "Created At", ro),
  ],
  outputs: [o("organizationId", "Organization ID")],
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "xata",
});

export const ProjectType = rt({
  name: "Project",
  id: "xata-project",
  description:
    "A Xata project: a group of Postgres branches sharing scale-to-zero and IP filtering settings",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID", { editable: false }),
    f("organizationId", "Organization", { editable: false }),
    f("baseScaleToZero", "Scale Base Branches to Zero", { kind: "boolean", required: false }),
    f("baseInactivityMinutes", "Base Branch Idle Minutes", { kind: "number", required: false }),
    f("childScaleToZero", "Scale Child Branches to Zero", { kind: "boolean", required: false }),
    f("childInactivityMinutes", "Child Branch Idle Minutes", { kind: "number", required: false }),
    f("ipFilteringEnabled", "IP Filtering", {
      kind: "boolean",
      required: false,
      description: "Only allow connections from the CIDRs below.",
    }),
    f("allowedCidrs", "Allowed CIDRs", {
      required: false,
      description: "Comma-separated IPs or CIDR blocks (up to 64).",
    }),
    f("branchCount", "Branches", { kind: "number", ...ro }),
    f("createdAt", "Created At", ro),
  ],
  outputs: [o("projectId", "Project ID")],
  dependsOn: [
    { fieldKey: "organizationId", targetTypeId: "xata-organization", label: "in organization" },
  ],
  postureChecks: [
    {
      id: "xata-project-ip-filtering-off",
      title: "Branches accept connections from any address",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "ipFilteringEnabled", when: "falsy" }],
      reason:
        "IP filtering is off for this project, so its branches' Postgres endpoints answer the whole internet and only the password protects them.",
    },
  ],
  parentTypeId: "xata-organization",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "xata",
});

export const BranchType = rt({
  name: "Branch",
  plural: "Branches",
  id: "xata-branch",
  description:
    "A Xata Postgres branch: its own cluster, copy-on-write from a parent or configured from scratch",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("branchId", "Branch ID", { editable: false }),
    f("projectId", "Project", { editable: false }),
    f("organizationId", "Organization", { editable: false }),
    f("parentId", "Parent Branch", ro),
    f("region", "Region", { editable: false }),
    f("statusType", "Status", ro),
    f("status", "Cluster Status", ro),
    f("statusMessage", "Status Message", ro),
    f("instanceType", "Instance Type", {
      ...ro,
      description:
        "Change it with the Change instance type action, which lists the sizes on offer.",
    }),
    f("image", "Postgres Image", ro),
    f("replicas", "Replicas", {
      kind: "number",
      required: false,
      description: "Standby replicas (0-4) besides the primary.",
    }),
    f("storageGb", "Storage (GiB)", { kind: "number", required: false }),
    f("instanceCount", "Instances", { kind: "number", ...ro }),
    f("instanceReadyCount", "Instances Ready", { kind: "number", ...ro }),
    f("scaleToZero", "Scale to Zero", { kind: "boolean", required: false }),
    f("inactivityMinutes", "Idle Minutes Before Hibernating", { kind: "number", required: false }),
    f("backupsEnabled", "Backups Available", { kind: "boolean", ...ro }),
    f("backupRetentionDays", "Backup Retention (days)", {
      kind: "number",
      required: false,
      description: "2-35 days.",
    }),
    f("publicAccess", "Public Endpoint", { kind: "boolean", ...ro }),
    f("host", "Host", ro),
    f("createdAt", "Created At", ro),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("host", "Host"),
    o("username", "Username"),
  ],
  dependsOn: [
    {
      fieldKey: "projectId",
      targetTypeId: "xata-project",
      matchTemplate: "{organizationId}/{projectId}",
      label: "in project",
    },
    {
      fieldKey: "parentId",
      targetTypeId: "xata-branch",
      matchTemplate: "{organizationId}/{projectId}/{parentId}",
      label: "branched from",
    },
  ],
  backupPolicy: { protectedBy: ["xata-backup"], automatedBackupFieldKey: "backupsEnabled" },
  lifecycle: {
    startActionId: "wake",
    stopActionId: "hibernate",
    statusFieldKey: "statusType",
    runningValues: ["STATUS_TYPE_HEALTHY"],
    stoppedValues: ["STATUS_TYPE_HIBERNATED"],
  },
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
      description: "DATABASE_URL for this branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
  supportsRestQuery: true,
  parentTypeId: "xata-project",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "xata",
});

export const BackupType = rt({
  name: "Backup",
  pinnable: false,
  id: "xata-backup",
  description: "A branch's continuous backup, restorable into a new branch",
  fields: [
    f("description", "Description", { required: false }),
    f("branchId", "Branch"),
    f("projectId", "Project"),
    f("organizationId", "Organization"),
    f("earliestRestore", "Earliest Restore Point", { required: false }),
    f("latestRestore", "Latest Restore Point", { required: false }),
  ],
  outputs: [],
  backupRole: {
    role: "snapshot",
    sourceTemplate: "{organizationId}/{projectId}/{branchId}",
    createdKey: "latestRestore",
  },
  dependsOn: [
    {
      fieldKey: "branchId",
      targetTypeId: "xata-branch",
      matchTemplate: "{organizationId}/{projectId}/{branchId}",
      label: "backup of",
    },
  ],
  parentTypeId: "xata-project",
  supportsDelete: false,
  iconKey: "xata",
});

export const ApiKeyType = rt({
  name: "API Key",
  pinnable: false,
  id: "xata-api-key",
  description: "An organization API key. The token is shown once, when the key is created.",
  fields: [
    f("name", "Name"),
    f("organizationId", "Organization"),
    f("preview", "Preview", { required: false }),
    f("scopes", "Scopes", { required: false }),
    f("projects", "Projects", { required: false, description: "Empty means every project." }),
    f("branches", "Branches", { required: false, description: "Empty means every branch." }),
    f("fullAccess", "Unrestricted", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
    f("lastUsedAt", "Last Used At", { required: false }),
  ],
  outputs: [o("token", "Token", { sensitive: true })],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "API key expires" },
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "api-token",
      label: "API key due for rotation",
    },
  ],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    adminIndicatorKey: "fullAccess",
    adminValues: ["true"],
  },
  parentTypeId: "xata-organization",
  supportsCreate: true,
  iconKey: "xata",
});

export const MemberType = rt({
  name: "Member",
  pinnable: false,
  id: "xata-member",
  description: "A member of the organization and their role",
  fields: [
    f("email", "Email", { editable: false }),
    f("name", "Name", ro),
    f("organizationId", "Organization", { editable: false }),
    f("role", "Role", {
      kind: "enum",
      enumValues: ["admin", "editor"],
      description: "Admins manage members, billing and keys; editors manage projects and branches.",
    }),
  ],
  outputs: [],
  principalRole: { role: "user", adminIndicatorKey: "role", adminValues: ["admin"] },
  parentTypeId: "xata-organization",
  supportsUpdate: true,
  iconKey: "xata",
});

export const InvitationType = rt({
  name: "Invitation",
  pinnable: false,
  id: "xata-invitation",
  description: "An invitation to join the organization",
  fields: [
    f("email", "Email"),
    f("organizationId", "Organization"),
    f("role", "Role", { kind: "enum", enumValues: ["admin", "editor"] }),
    f("status", "Status", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [],
  parentTypeId: "xata-organization",
  supportsCreate: true,
  iconKey: "xata",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  OrganizationType,
  ProjectType,
  BranchType,
  BackupType,
  ApiKeyType,
  MemberType,
  InvitationType,
];
