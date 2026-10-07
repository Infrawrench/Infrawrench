import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * External ids:
 * - index, collection, assistant: the name (Pinecone addresses them by name)
 * - backup: `backup_id`; backup schedule: `schedule_id`; restore job: `restore_job_id`
 * - project, API key, service account: the Admin API's UUID
 */

export const INDEX_STATES = [
  "Ready",
  "Initializing",
  "InitializationFailed",
  "Failed",
  "ScalingUp",
  "ScalingDown",
  "ScalingUpPodSize",
  "Terminating",
  "Disabled",
];

export const API_KEY_ROLES = [
  "ProjectEditor",
  "ProjectViewer",
  "ControlPlaneEditor",
  "ControlPlaneViewer",
  "DataPlaneEditor",
  "DataPlaneViewer",
] as const;

export const API_KEY_ROLE_LABELS: Record<string, string> = {
  ProjectEditor: "Project editor (everything in the project)",
  ProjectViewer: "Project viewer (read everything)",
  ControlPlaneEditor: "Control plane editor (manage indexes)",
  ControlPlaneViewer: "Control plane viewer (list and describe indexes)",
  DataPlaneEditor: "Data plane editor (read and write records)",
  DataPlaneViewer: "Data plane viewer (query and fetch records)",
};

export const POD_TYPES = ["s1", "p1", "p2"].flatMap((t) =>
  ["x1", "x2", "x4", "x8"].map((s) => `${t}.${s}`),
);

/**
 * Serverless regions per Pinecone's "Create an index" guide (2026-10): the
 * control plane has no region listing call. Starter-plan projects only get
 * AWS us-east-1; a refused region surfaces as Pinecone's own 4xx.
 */
export const SERVERLESS_REGIONS: Array<{ cloud: string; region: string; label: string }> = [
  { cloud: "aws", region: "us-east-1", label: "AWS us-east-1 (Virginia)" },
  { cloud: "aws", region: "us-west-2", label: "AWS us-west-2 (Oregon)" },
  { cloud: "aws", region: "eu-west-1", label: "AWS eu-west-1 (Ireland)" },
  { cloud: "aws", region: "eu-central-1", label: "AWS eu-central-1 (Frankfurt)" },
  { cloud: "aws", region: "ap-southeast-1", label: "AWS ap-southeast-1 (Singapore)" },
  { cloud: "gcp", region: "us-central1", label: "GCP us-central1 (Iowa)" },
  { cloud: "gcp", region: "europe-west4", label: "GCP europe-west4 (Netherlands)" },
  { cloud: "azure", region: "eastus2", label: "Azure eastus2 (Virginia)" },
];

export const IndexResourceType = rt({
  name: "Index",
  plural: "Indexes",
  id: "index",
  description:
    "A Pinecone index: serverless (managed), BYOC or pod-based, with its read capacity, deletion protection and tags",
  fields: [
    f("name", "Name", { editable: false }),
    f("deploymentType", "Deployment", {
      kind: "enum",
      enumValues: ["managed", "pod", "byoc"],
      editable: false,
      description: "managed is serverless; pod is the older pod-based infrastructure",
    }),
    f("status", "Status", { kind: "enum", enumValues: INDEX_STATES, editable: false }),
    f("ready", "Ready", { kind: "boolean", required: false, editable: false }),
    f("kind", "Kind", {
      kind: "enum",
      enumValues: ["dense", "sparse", "integrated", "documents"],
      required: false,
      editable: false,
      description:
        "dense or sparse vectors, integrated (Pinecone embeds text with a hosted model), or documents (full-text search fields)",
    }),
    f("vectorType", "Vector Type", { required: false, editable: false }),
    f("dimension", "Dimension", { kind: "number", required: false, editable: false }),
    f("metric", "Metric", { required: false, editable: false }),
    f("embedModel", "Embedding Model", { required: false, editable: false }),
    f("fullTextFields", "Full-Text Fields", { required: false, editable: false }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("host", "Host", { required: false, editable: false }),
    f("deletionProtection", "Deletion Protection", {
      kind: "enum",
      enumValues: ["disabled", "enabled"],
      required: false,
      description: "While enabled, Pinecone refuses to delete the index",
    }),
    f("tags", "Tags", {
      required: false,
      description:
        "Comma-separated key=value pairs, at most 20. Keys are letters, digits, _ or -, up to 80 characters; values up to 120.",
    }),
    f("readCapacityMode", "Read Capacity", {
      kind: "enum",
      enumValues: ["OnDemand", "Dedicated"],
      required: false,
      description:
        "OnDemand bills per read unit. Dedicated provisions read nodes billed by the hour. Serverless and BYOC indexes only.",
    }),
    f("nodeType", "Read Node Type", {
      kind: "enum",
      enumValues: ["b1", "t1"],
      required: false,
      description: "Dedicated read nodes: b1, or t1 with more processing power and memory",
    }),
    f("replicas", "Replicas", {
      kind: "number",
      required: false,
      description:
        "Dedicated read replicas (0 pauses reads), or pod replicas for a pod-based index (at least 1)",
    }),
    f("shards", "Shards", {
      kind: "number",
      required: false,
      description:
        "Dedicated read shards, 250 GB of storage each. Fixed at creation for pod-based indexes.",
    }),
    f("podType", "Pod Type", {
      kind: "enum",
      enumValues: POD_TYPES,
      required: false,
      description: "Pod-based indexes only. Pods can be scaled up in size, never down.",
    }),
    f("pods", "Pods", { kind: "number", required: false, editable: false }),
    f("readCapacityState", "Read Capacity State", { required: false, editable: false }),
    f("readCapacityError", "Read Capacity Error", { required: false, editable: false }),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
    f("namespaceCount", "Namespaces", { kind: "number", required: false, editable: false }),
    f("privateHost", "Private Host", { required: false, editable: false }),
    f("sourceCollection", "Source Collection", { required: false, editable: false }),
    f("sourceBackupId", "Restored From Backup", { required: false, editable: false }),
    f("cmekId", "CMEK Key", { required: false, editable: false }),
  ],
  outputs: [
    o("indexName", "Index Name"),
    o("host", "Host URL", { description: "Data-plane endpoint for upserts and queries" }),
    o("privateHost", "Private Host URL"),
    o("apiKey", "API Key", {
      sensitive: true,
      description: "The project API key this account uses",
    }),
  ],
  secretExportTemplates: [
    {
      id: "pinecone-env",
      displayName: "Pinecone environment variables",
      description: "PINECONE_API_KEY, PINECONE_INDEX and PINECONE_HOST",
      entries: [
        { envKey: "PINECONE_API_KEY", outputKey: "apiKey" },
        { envKey: "PINECONE_INDEX", outputKey: "indexName" },
        { envKey: "PINECONE_HOST", outputKey: "host" },
      ],
    },
  ],
  dependsOn: [
    { fieldKey: "sourceCollection", targetTypeId: "collection", label: "created from" },
    { fieldKey: "sourceBackupId", targetTypeId: "backup", label: "restored from" },
  ],
  backupPolicy: { protectedBy: ["backup"] },
  postureChecks: [
    {
      id: "pinecone-index-deletion-protection-off",
      title: "Deletion protection is off",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "deletionProtection", when: "equals", value: "disabled" }],
      reason:
        "Anyone with a control-plane key can delete this index and every record in it in one call. Enable deletion protection on indexes you would not want to rebuild.",
    },
  ],
  iconKey: "index",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});

export const CollectionResourceType = rt({
  name: "Collection",
  id: "collection",
  description: "A static copy of a pod-based index",
  fields: [
    f("name", "Name", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["Initializing", "Ready", "Terminating", "Terminated"],
      editable: false,
    }),
    f("environment", "Environment", { required: false, editable: false }),
    f("dimension", "Dimension", { kind: "number", required: false, editable: false }),
    f("vectorCount", "Records", { kind: "number", required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
  ],
  iconKey: "collection",
  supportsCreate: true,
});

export const BackupResourceType = rt({
  name: "Backup",
  id: "backup",
  description: "A backup of a serverless index, restorable into a new index",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("backupId", "Backup ID", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("sourceIndexName", "Source Index", { editable: false }),
    f("sourceIndexId", "Source Index ID", { required: false, editable: false }),
    f("sourceIndexDeletedAt", "Source Index Deleted", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["Ready", "Initializing", "InitializationFailed"],
      editable: false,
    }),
    f("cloud", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
    f("namespaceCount", "Namespaces", { kind: "number", required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "sourceIndexName", targetTypeId: "index", label: "backup of" }],
  backupRole: {
    role: "snapshot",
    sourceKey: "sourceIndexName",
    createdKey: "createdAt",
    sizeKey: "sizeBytes",
    sizeUnit: "bytes",
  },
  orphanRule: {
    conditions: [{ fieldKey: "sourceIndexDeletedAt", when: "notEquals", value: "" }],
    reason: "The index this backup was taken from has been deleted; the backup is still stored",
  },
  iconKey: "backup",
  showInSidebar: true,
  supportsCreate: true,
});

export const BackupScheduleResourceType = rt({
  name: "Backup Schedule",
  id: "backup-schedule",
  parentTypeId: "index",
  showInSidebar: true,
  description: "Automatic daily, weekly or monthly backups of a serverless index",
  fields: [
    f("name", "Name", { editable: false }),
    f("scheduleId", "Schedule ID", { editable: false }),
    f("indexName", "Index", { editable: false }),
    f("indexId", "Index ID", { required: false, editable: false }),
    f("frequency", "Frequency", {
      kind: "enum",
      enumValues: ["daily", "weekly", "monthly"],
    }),
    f("retentionDays", "Retention (days)", {
      kind: "number",
      description: "How long each scheduled backup is kept, at least 1 day",
    }),
    f("enabled", "Enabled", {
      kind: "boolean",
      description: "Disabled schedules do not run. Re-enabling starts a backup right away.",
    }),
    f("nextScheduledRun", "Next Run", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "indexName", targetTypeId: "index", label: "backs up" }],
  iconKey: "schedule",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RestoreJobResourceType = rt({
  name: "Restore Job",
  id: "restore-job",
  description: "Restoring a backup into a new index",
  fields: [
    f("restoreJobId", "Restore Job ID", { editable: false }),
    f("backupId", "Backup", { editable: false }),
    f("targetIndexName", "Target Index", { editable: false }),
    f("targetIndexId", "Target Index ID", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["Pending", "Completed", "Failed", "Cancelled"],
      editable: false,
    }),
    f("percentComplete", "Progress (%)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Started", { required: false, editable: false }),
    f("completedAt", "Completed", { required: false, editable: false }),
  ],
  dependsOn: [
    { fieldKey: "backupId", targetTypeId: "backup", label: "restores" },
    { fieldKey: "targetIndexName", targetTypeId: "index", label: "into" },
  ],
  iconKey: "restore",
  pinnable: false,
  supportsDelete: false,
});

export const AssistantResourceType = rt({
  name: "Assistant",
  id: "assistant",
  description: "A Pinecone Assistant: a chat model grounded in uploaded files",
  fields: [
    f("name", "Name", { editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["Ready", "Initializing", "Failed", "Terminating", "InitializationFailed"],
      editable: false,
    }),
    f("region", "Region", { kind: "enum", enumValues: ["us", "eu"], editable: false }),
    f("host", "Host", { required: false, editable: false }),
    f("instructions", "Instructions", {
      required: false,
      description: "Guidance applied to every response, at most 16 KB",
    }),
    f("metadata", "Metadata (JSON)", {
      required: false,
      description: 'A JSON object of your own labels, e.g. {"team": "support"}. At most 16 KB.',
    }),
    f("fileCount", "Files", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("assistantName", "Assistant Name"), o("host", "Host URL")],
  iconKey: "assistant",
  supportsCreate: true,
  supportsUpdate: true,
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description: "A Pinecone project (Admin API): a container for indexes, assistants and API keys",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID", { editable: false }),
    f("maxPods", "Max Pods", {
      kind: "number",
      required: false,
      description: "Pods the project may run across pod-based indexes. 0 means serverless only.",
    }),
    f("forceEncryptionWithCmek", "Require CMEK Encryption", {
      kind: "boolean",
      required: false,
      description:
        "Every new index must use a customer-managed key. Once turned on it cannot be turned off.",
    }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("projectId", "Project ID")],
  iconKey: "project",
  supportsCreate: true,
  supportsUpdate: true,
});

export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  parentTypeId: "project",
  showInSidebar: true,
  description: "A project API key and the roles it carries (Admin API)",
  fields: [
    f("name", "Name", { description: "1 to 80 characters" }),
    f("keyId", "Key ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("projectName", "Project", { required: false, editable: false }),
    f("roles", "Roles", {
      required: false,
      description: `Comma-separated, any of: ${API_KEY_ROLES.join(", ")}. Replaces the key's current roles.`,
    }),
  ],
  outputs: [
    o("apiKey", "API Key Value", {
      sensitive: true,
      description: "Only available for keys created from Infrawrench; Pinecone shows a key once",
    }),
  ],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "project" }],
  principalRole: {
    role: "key",
    adminIndicatorKey: "roles",
    adminValues: ["ProjectEditor"],
    parentKey: "projectName",
  },
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
});

export const ServiceAccountResourceType = rt({
  name: "Service Account",
  id: "service-account",
  description: "An organization service account for the Admin API (OAuth client credentials)",
  fields: [
    f("name", "Name", { description: "1 to 80 characters" }),
    f("serviceAccountId", "Service Account ID", { editable: false }),
    f("clientId", "Client ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("clientId", "Client ID"),
    o("clientSecret", "Client Secret", {
      sensitive: true,
      description:
        "Only available after creating or rotating from Infrawrench; Pinecone shows a secret once",
    }),
  ],
  principalRole: { role: "service-account" },
  iconKey: "user",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  IndexResourceType,
  CollectionResourceType,
  BackupResourceType,
  BackupScheduleResourceType,
  RestoreJobResourceType,
  AssistantResourceType,
  ProjectResourceType,
  ApiKeyResourceType,
  ServiceAccountResourceType,
];
