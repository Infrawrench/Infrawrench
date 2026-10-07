import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const EndpointResourceType = rt({
  id: "endpoint",
  name: "Endpoint",
  description:
    "The S3-compatible endpoint itself: which server software answers, how many buckets it holds and, on MinIO, the cluster's mode, capacity, usage and server health.",
  fields: [
    f("endpoint", "Endpoint", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("addressing", "Addressing", { required: false, editable: false }),
    f("server", "Server", { required: false, editable: false }),
    f("bucketCount", "Buckets", { kind: "number", required: false, editable: false }),
    f("minioMode", "MinIO Mode", { required: false, editable: false }),
    f("minioVersion", "MinIO Version", { required: false, editable: false }),
    f("deploymentId", "Deployment ID", { required: false, editable: false }),
    f("objects", "Objects", { kind: "number", required: false, editable: false }),
    f("usedBytes", "Used (bytes)", { kind: "number", required: false, editable: false }),
    f("capacityBytes", "Capacity (bytes)", { kind: "number", required: false, editable: false }),
    f("freeBytes", "Free (bytes)", { kind: "number", required: false, editable: false }),
    f("serversOnline", "Servers Online", { kind: "number", required: false, editable: false }),
    f("serversTotal", "Servers", { kind: "number", required: false, editable: false }),
    f("drivesOnline", "Drives Online", { kind: "number", required: false, editable: false }),
    f("drivesTotal", "Drives", { kind: "number", required: false, editable: false }),
    f("adminApi", "Admin API", { required: false, editable: false }),
  ],
  outputs: [o("endpoint", "Endpoint URL"), o("region", "Region")],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
});

export const ServerResourceType = rt({
  id: "minio-server",
  name: "MinIO Server",
  description: "One server of a MinIO deployment, with its state, version, uptime and drives.",
  parentTypeId: "endpoint",
  showInSidebar: true,
  fields: [
    f("endpoint", "Endpoint", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("edition", "Edition", { required: false, editable: false }),
    f("uptimeSeconds", "Uptime (seconds)", { kind: "number", required: false, editable: false }),
    f("pool", "Pool", { kind: "number", required: false, editable: false }),
    f("drivesOnline", "Drives Online", { kind: "number", required: false, editable: false }),
    f("drivesTotal", "Drives", { kind: "number", required: false, editable: false }),
    f("drivesHealing", "Drives Healing", { kind: "number", required: false, editable: false }),
    f("usedBytes", "Used (bytes)", { kind: "number", required: false, editable: false }),
    f("totalBytes", "Total (bytes)", { kind: "number", required: false, editable: false }),
    f("drives", "Drive Details (JSON)", { required: false, editable: false }),
  ],
  outputs: [],
  supportsDelete: false,
  supportsMetrics: true,
  pinnable: true,
  iconKey: "server",
});

export const BucketResourceType = rt({
  id: "bucket",
  name: "Bucket",
  description:
    "A bucket on the endpoint. Browse, upload and delete objects, edit its policy, versioning, Object Lock default retention and tags, and manage lifecycle and CORS rules.",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("versioning", "Versioning", {
      kind: "enum",
      enumValues: ["Enabled", "Suspended", "Unversioned"],
      required: false,
      description: "Once enabled, versioning can be suspended but never turned off.",
    }),
    f("objectLock", "Object Lock", { kind: "boolean", required: false, editable: false }),
    f("retentionMode", "Default Retention Mode", {
      kind: "enum",
      enumValues: ["none", "GOVERNANCE", "COMPLIANCE"],
      required: false,
    }),
    f("retentionDays", "Default Retention (days)", { kind: "number", required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated key=value pairs." }),
    f("hasPolicy", "Has Bucket Policy", { kind: "boolean", required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("objects", "Objects", { kind: "number", required: false, editable: false }),
  ],
  outputs: [
    o("bucketName", "Bucket Name"),
    o("endpoint", "S3 Endpoint"),
    o("region", "Region"),
    o("s3Url", "Bucket URL"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsStorageBrowser: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "s3-endpoint",
      displayName: "S3 endpoint and bucket",
      entries: [
        { envKey: "S3_ENDPOINT", outputKey: "endpoint" },
        { envKey: "S3_REGION", outputKey: "region" },
        { envKey: "S3_BUCKET", outputKey: "bucketName" },
      ],
    },
  ],
  postureChecks: [
    {
      id: "s3-compatible-bucket-unversioned",
      title: "Versioning is off",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "versioning", when: "notEquals", value: "Enabled" }],
      reason: "Overwritten or deleted objects cannot be recovered.",
    },
  ],
  iconKey: "bucket",
});

export const LifecycleRuleResourceType = rt({
  id: "lifecycle-rule",
  name: "Lifecycle Rule",
  description:
    "Expires current or previous object versions by age for a prefix, and aborts stale multipart uploads.",
  parentTypeId: "bucket",
  fields: [
    f("bucket", "Bucket", { editable: false }),
    f("ruleId", "Rule ID", { editable: false }),
    f("prefix", "Prefix", { required: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("expirationDays", "Expire Objects After (days)", { kind: "number", required: false }),
    f("noncurrentDays", "Expire Previous Versions After (days)", {
      kind: "number",
      required: false,
    }),
    f("abortMultipartDays", "Abort Incomplete Uploads After (days)", {
      kind: "number",
      required: false,
    }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  dependsOn: [
    { fieldKey: "bucket", targetTypeId: "bucket", targetKey: "name", label: "applies to" },
  ],
  iconKey: "rule",
});

export const CorsRuleResourceType = rt({
  id: "cors-rule",
  name: "CORS Rule",
  description:
    "Lets browsers on the listed origins use the listed HTTP methods against this bucket (not every server supports bucket CORS).",
  parentTypeId: "bucket",
  fields: [
    f("bucket", "Bucket", { editable: false }),
    f("ruleId", "Rule ID", { editable: false }),
    f("allowedOrigins", "Allowed Origins", { description: "Comma-separated, or * for any." }),
    f("allowedMethods", "Allowed Methods", {
      description: "Comma-separated: GET, PUT, POST, DELETE, HEAD.",
    }),
    f("allowedHeaders", "Allowed Headers", { required: false }),
    f("exposeHeaders", "Exposed Headers", { required: false }),
    f("maxAgeSeconds", "Max Age (seconds)", { kind: "number", required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  dependsOn: [
    { fieldKey: "bucket", targetTypeId: "bucket", targetKey: "name", label: "applies to" },
  ],
  iconKey: "rule",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  EndpointResourceType,
  ServerResourceType,
  BucketResourceType,
  LifecycleRuleResourceType,
  CorsRuleResourceType,
];
