import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Backblaze B2 resource types. Buckets carry their lifecycle, CORS and
 * replication rules inline in the Native API (`b2_update_bucket` replaces the
 * whole array), and notification rules are a per-bucket array too
 * (`b2_set_bucket_notification_rules`). Each rule is modelled as its own child
 * resource so it can be created, edited and deleted one at a time; the plugin
 * does the read-modify-write against the bucket's `revision`.
 */

export const AccountResourceType = rt({
  id: "account",
  name: "Account",
  description:
    "The Backblaze B2 account the application key belongs to: its S3 endpoint, what the key may do, and month-to-date usage from the daily usage reports.",
  fields: [
    f("accountId", "Account ID", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("s3Region", "S3 Region", { required: false, editable: false }),
    f("s3Endpoint", "S3 Endpoint", { required: false, editable: false }),
    f("capabilities", "Key Capabilities", { required: false, editable: false }),
    f("keyRestrictedTo", "Key Restricted To", { required: false, editable: false }),
    f("namePrefix", "Key Name Prefix", { required: false, editable: false }),
    f("keyExpiresAt", "Key Expires", { required: false, editable: false }),
    f("bucketCount", "Buckets", { kind: "number", required: false, editable: false }),
    f("usageReports", "Usage Reports", { required: false, editable: false }),
  ],
  outputs: [
    o("accountId", "Account ID"),
    o("s3Endpoint", "S3 Endpoint"),
    o("s3Region", "S3 Region"),
    o("downloadUrl", "Download URL"),
  ],
  supportsMetrics: true,
  supportsDelete: false,
  credentialFormats: [
    {
      id: "all-buckets-rw",
      label: "Read/write key for all buckets",
      description:
        "A new application key that can list, read, write and delete files in every bucket. Works with the S3-compatible API.",
      mediaType: "ini",
      filenameTemplate: "b2-all-buckets.ini",
    },
    {
      id: "all-buckets-ro",
      label: "Read-only key for all buckets",
      description: "A new application key that can list and download files in every bucket.",
      mediaType: "ini",
      filenameTemplate: "b2-all-buckets-readonly.ini",
    },
  ],
  expiryFields: [
    {
      fieldKey: "keyExpiresAt",
      from: "expiry",
      kind: "api-token",
      label: "Application key expires",
    },
  ],
  iconKey: "account",
});

export const BucketResourceType = rt({
  id: "bucket",
  name: "Bucket",
  description:
    "A B2 bucket. Browse, upload and delete files, change visibility, default encryption, Object Lock retention and bucket info, and manage its lifecycle, CORS, replication and event notification rules.",
  fields: [
    f("name", "Name", { editable: false }),
    f("bucketId", "Bucket ID", { required: false, editable: false }),
    f("bucketType", "Visibility", {
      kind: "enum",
      enumValues: ["allPrivate", "allPublic"],
      description:
        "allPrivate needs authorization to download; allPublic lets anyone download by URL.",
    }),
    f("encryption", "Default Encryption", {
      kind: "enum",
      enumValues: ["none", "SSE-B2"],
      required: false,
      description: "SSE-B2 encrypts every new file at rest with AES-256 keys Backblaze manages.",
    }),
    f("objectLock", "Object Lock", {
      kind: "boolean",
      required: false,
      description: "Once Object Lock is enabled on a bucket it cannot be turned off.",
    }),
    f("retentionMode", "Default Retention Mode", {
      kind: "enum",
      enumValues: ["none", "governance", "compliance"],
      required: false,
      description:
        "Applied to new files when Object Lock is on. Compliance retention cannot be shortened or removed by anyone.",
    }),
    f("retentionDays", "Default Retention (days)", {
      kind: "number",
      required: false,
      description: "How long new files stay locked. Ignored when the retention mode is none.",
    }),
    f("cacheControl", "Default Cache-Control", {
      required: false,
      description:
        "Stored in the bucket info as Cache-Control; B2 sends it with every download from this bucket that has no Cache-Control of its own.",
    }),
    f("region", "Region", { required: false, editable: false }),
    f("s3Region", "S3 Region", { required: false, editable: false }),
    f("lifecycleRuleCount", "Lifecycle Rules", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("corsRuleCount", "CORS Rules", { kind: "number", required: false, editable: false }),
    f("replicationRuleCount", "Replication Rules", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("isReplicationDestination", "Replication Destination", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("revision", "Revision", { kind: "number", required: false, editable: false }),
    f("options", "Options", { required: false, editable: false }),
    f("bucketInfo", "Bucket Info (JSON)", { required: false, editable: false }),
    f("lifecycleRulesJson", "Lifecycle Rules (JSON)", { required: false, editable: false }),
    f("corsRulesJson", "CORS Rules (JSON)", { required: false, editable: false }),
  ],
  outputs: [
    o("bucketName", "Bucket Name"),
    o("bucketId", "Bucket ID"),
    o("s3Endpoint", "S3 Endpoint"),
    o("s3Region", "S3 Region"),
    o("friendlyUrl", "Friendly Download URL"),
    o("s3Url", "S3 Bucket URL"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsStorageBrowser: true,
  supportsMetrics: true,
  credentialFormats: [
    {
      id: "bucket-rw",
      label: "Read/write key for this bucket",
      description:
        "A new application key limited to this bucket that can list, read, write and delete files. Works with the S3-compatible API.",
      mediaType: "ini",
      filenameTemplate: "b2-{resource}.ini",
    },
    {
      id: "bucket-ro",
      label: "Read-only key for this bucket",
      description: "A new application key limited to this bucket that can list and download files.",
      mediaType: "ini",
      filenameTemplate: "b2-{resource}-readonly.ini",
    },
  ],
  secretExportTemplates: [
    {
      id: "s3-endpoint",
      displayName: "S3 endpoint and bucket",
      entries: [
        { envKey: "S3_ENDPOINT", outputKey: "s3Endpoint" },
        { envKey: "S3_REGION", outputKey: "s3Region" },
        { envKey: "S3_BUCKET", outputKey: "bucketName" },
      ],
    },
  ],
  postureChecks: [
    {
      id: "b2-bucket-public",
      title: "Bucket is public",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "bucketType", when: "equals", value: "allPublic" }],
      reason:
        "Anyone who knows a file's name can download it from this bucket without authorization.",
    },
    {
      id: "b2-bucket-unencrypted",
      title: "Default encryption is off",
      severity: "low",
      category: "encryption",
      conditions: [{ fieldKey: "encryption", when: "equals", value: "none" }],
      reason: "New files are stored without SSE-B2 server-side encryption.",
    },
  ],
  dnsServiceHosts: [
    {
      id: "b2-s3-bucket",
      label: "B2 S3 bucket endpoint",
      hostPattern: "([a-z0-9][a-z0-9-]{4,48}[a-z0-9])\\.s3\\.[a-z0-9-]+\\.backblazeb2\\.com",
      reason:
        "Bucket names are global, so whoever creates a bucket with this name can serve content on this hostname.",
    },
  ],
  iconKey: "bucket",
});

export const LifecycleRuleResourceType = rt({
  id: "lifecycle-rule",
  name: "Lifecycle Rule",
  description:
    "Hides and deletes file versions by age for files whose names start with a prefix, and cancels abandoned large-file uploads.",
  parentTypeId: "bucket",
  fields: [
    f("bucketId", "Bucket ID", { editable: false }),
    f("bucketName", "Bucket", { required: false, editable: false }),
    f("fileNamePrefix", "File Name Prefix", {
      required: false,
      description: "Applies to files whose names start with this. Empty means every file.",
    }),
    f("daysFromUploadingToHiding", "Hide After (days since upload)", {
      kind: "number",
      required: false,
      description: "Hide the current version this many days after upload. Empty keeps it visible.",
    }),
    f("daysFromHidingToDeleting", "Delete After (days hidden)", {
      kind: "number",
      required: false,
      description:
        "Delete non-current (hidden) versions this many days after they were hidden. 1 keeps only the latest version.",
    }),
    f("daysFromStartingToCancelingUnfinishedLargeFiles", "Cancel Unfinished Uploads After (days)", {
      kind: "number",
      required: false,
    }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  dependsOn: [{ fieldKey: "bucketId", targetTypeId: "bucket", label: "applies to" }],
  pinnable: false,
  iconKey: "rule",
});

export const CorsRuleResourceType = rt({
  id: "cors-rule",
  name: "CORS Rule",
  description:
    "Lets browsers on the listed origins call the listed B2 or S3 operations on this bucket.",
  parentTypeId: "bucket",
  fields: [
    f("bucketId", "Bucket ID", { editable: false }),
    f("bucketName", "Bucket", { required: false, editable: false }),
    f("corsRuleName", "Name", { editable: false }),
    f("allowedOrigins", "Allowed Origins", {
      description: "Comma-separated origins such as https://app.example.com, or * for any.",
    }),
    f("allowedOperations", "Allowed Operations", {
      description:
        "Comma-separated: s3_get, s3_head, s3_put, s3_delete, b2_download_file_by_name, b2_download_file_by_id, b2_upload_file, b2_upload_part.",
    }),
    f("allowedHeaders", "Allowed Headers", { required: false }),
    f("exposeHeaders", "Exposed Headers", { required: false }),
    f("maxAgeSeconds", "Max Age (seconds)", { kind: "number", required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  dependsOn: [{ fieldKey: "bucketId", targetTypeId: "bucket", label: "applies to" }],
  pinnable: false,
  iconKey: "rule",
});

export const ReplicationRuleResourceType = rt({
  id: "replication-rule",
  name: "Replication Rule",
  description:
    "Copies new (and optionally existing) files from this bucket to another bucket in the same account.",
  parentTypeId: "bucket",
  fields: [
    f("bucketId", "Source Bucket ID", { editable: false }),
    f("bucketName", "Source Bucket", { required: false, editable: false }),
    f("replicationRuleName", "Name", { editable: false }),
    f("destinationBucketId", "Destination Bucket ID", { editable: false }),
    f("destinationBucketName", "Destination Bucket", { required: false, editable: false }),
    f("fileNamePrefix", "File Name Prefix", { required: false }),
    f("priority", "Priority", {
      kind: "number",
      required: false,
      description: "When two rules match a file, the higher priority wins (1 to 2147483647).",
    }),
    f("isEnabled", "Enabled", { kind: "boolean", required: false }),
    f("includeExistingFiles", "Include Existing Files", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  dependsOn: [
    { fieldKey: "bucketId", targetTypeId: "bucket", label: "replicates from" },
    { fieldKey: "destinationBucketId", targetTypeId: "bucket", label: "replicates to" },
  ],
  pinnable: false,
  iconKey: "rule",
});

export const NotificationRuleResourceType = rt({
  id: "notification-rule",
  name: "Event Notification",
  description: "Calls a webhook when files in this bucket are created, deleted or hidden.",
  parentTypeId: "bucket",
  fields: [
    f("bucketId", "Bucket ID", { editable: false }),
    f("bucketName", "Bucket", { required: false, editable: false }),
    f("name", "Name", { editable: false }),
    f("url", "Webhook URL", { description: "HTTPS only, and not on a Backblaze domain." }),
    f("eventTypes", "Event Types", {
      description: "Comma-separated, for example b2:ObjectCreated:*, b2:ObjectDeleted:*.",
    }),
    f("objectNamePrefix", "Object Name Prefix", { required: false }),
    f("isEnabled", "Enabled", { kind: "boolean", required: false }),
    f("maxEventsPerBatch", "Events Per Webhook Call", {
      kind: "number",
      required: false,
      description: "1 to 50.",
    }),
    f("customHeaders", "Custom Headers", {
      required: false,
      description: "Comma-separated Name=Value pairs, at most 10.",
    }),
    f("isSuspended", "Suspended", { kind: "boolean", required: false, editable: false }),
    f("suspensionReason", "Suspension Reason", { required: false, editable: false }),
  ],
  outputs: [o("signingSecret", "Signing Secret", { sensitive: true })],
  supportsCreate: true,
  supportsUpdate: true,
  dependsOn: [{ fieldKey: "bucketId", targetTypeId: "bucket", label: "watches" }],
  pinnable: false,
  iconKey: "webhook",
});

export const ApplicationKeyResourceType = rt({
  id: "application-key",
  name: "Application Key",
  description:
    "A B2 application key: its capabilities, the buckets and file prefix it is limited to, and when it expires.",
  fields: [
    f("keyName", "Name", { editable: false }),
    f("applicationKeyId", "Key ID", { editable: false }),
    f("capabilities", "Capabilities", { editable: false }),
    f("bucketIds", "Bucket IDs", { required: false, editable: false }),
    f("bucketNames", "Buckets", { required: false, editable: false }),
    f("namePrefix", "File Name Prefix", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("isAdmin", "Can Manage Keys", { kind: "boolean", required: false, editable: false }),
    f("options", "Options", { required: false, editable: false }),
  ],
  outputs: [
    o("applicationKeyId", "Key ID"),
    o("applicationKey", "Application Key", {
      sensitive: true,
      description:
        "Only available for keys created from Infrawrench; B2 shows a key's secret once.",
    }),
  ],
  supportsCreate: true,
  secretExportTemplates: [
    {
      id: "s3-env",
      displayName: "AWS-style S3 credentials",
      entries: [
        { envKey: "AWS_ACCESS_KEY_ID", outputKey: "applicationKeyId" },
        { envKey: "AWS_SECRET_ACCESS_KEY", outputKey: "applicationKey" },
      ],
    },
    {
      id: "b2-env",
      displayName: "B2 CLI credentials",
      entries: [
        { envKey: "B2_APPLICATION_KEY_ID", outputKey: "applicationKeyId" },
        { envKey: "B2_APPLICATION_KEY", outputKey: "applicationKey" },
      ],
    },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Application key expires" },
  ],
  principalRole: {
    role: "key",
    adminIndicatorKey: "isAdmin",
  },
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  BucketResourceType,
  LifecycleRuleResourceType,
  CorsRuleResourceType,
  ReplicationRuleResourceType,
  NotificationRuleResourceType,
  ApplicationKeyResourceType,
];
