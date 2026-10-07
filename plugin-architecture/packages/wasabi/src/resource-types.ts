import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const AccountResourceType = rt({
  id: "account",
  name: "Account",
  description:
    "The Wasabi account the access key belongs to, with its latest daily storage, object count and estimated monthly cost from the Stats API.",
  fields: [
    f("acctNum", "Account Number", { editable: false }),
    f("activeStorageGib", "Active Storage (GiB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("deletedStorageGib", "Timed Deleted Storage (GiB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("objects", "Objects", { kind: "number", required: false, editable: false }),
    f("estimatedMonthlyUsd", "Estimated Monthly Cost (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("utilizationDate", "Utilization As Of", { required: false, editable: false }),
    f("bucketCount", "Buckets", { kind: "number", required: false, editable: false }),
    f("subAccounts", "Account Control", { required: false, editable: false }),
  ],
  outputs: [o("s3Endpoint", "S3 Endpoint")],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "account",
});

export const BucketResourceType = rt({
  id: "bucket",
  name: "Bucket",
  description:
    "A Wasabi bucket. Browse, upload and delete objects, edit its policy, versioning, Object Lock default retention and tags, manage lifecycle and CORS rules, mint bucket-scoped keys, and chart its daily storage.",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { editable: false }),
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
      description: "Only applies when the bucket was created with Object Lock.",
    }),
    f("retentionDays", "Default Retention (days)", { kind: "number", required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated key=value pairs." }),
    f("activeStorageGib", "Active Storage (GiB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("objects", "Objects", { kind: "number", required: false, editable: false }),
  ],
  outputs: [
    o("bucketName", "Bucket Name"),
    o("region", "Region"),
    o("s3Endpoint", "S3 Endpoint"),
    o("s3Url", "Bucket URL"),
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
        "Creates an IAM user whose inline policy covers only this bucket, and an access key for it.",
      mediaType: "ini",
      filenameTemplate: "wasabi-{resource}.ini",
    },
    {
      id: "bucket-ro",
      label: "Read-only key for this bucket",
      description: "Same, with list and download permissions only.",
      mediaType: "ini",
      filenameTemplate: "wasabi-{resource}-readonly.ini",
    },
  ],
  secretExportTemplates: [
    {
      id: "s3-endpoint",
      displayName: "S3 endpoint and bucket",
      entries: [
        { envKey: "S3_ENDPOINT", outputKey: "s3Endpoint" },
        { envKey: "S3_REGION", outputKey: "region" },
        { envKey: "S3_BUCKET", outputKey: "bucketName" },
      ],
    },
  ],
  postureChecks: [
    {
      id: "wasabi-bucket-unversioned",
      title: "Versioning is off",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "versioning", when: "notEquals", value: "Enabled" }],
      reason: "Overwritten or deleted objects cannot be recovered.",
    },
  ],
  dnsServiceHosts: [
    {
      id: "wasabi-bucket",
      label: "Wasabi bucket endpoint",
      hostPattern: "([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\\.s3(?:\\.[a-z0-9-]+)?\\.wasabisys\\.com",
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
    "Expires current or non-current object versions by age for a prefix, and aborts stale multipart uploads.",
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
    "Lets browsers on the listed origins use the listed HTTP methods against this bucket.",
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

export const IamUserResourceType = rt({
  id: "iam-user",
  name: "IAM User",
  description:
    "A sub-user of the Wasabi account, with its attached and inline policies and access keys.",
  fields: [
    f("userName", "User Name", { editable: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("arn", "ARN", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("policies", "Attached Policies", {
      required: false,
      description: "Comma-separated policy ARNs.",
    }),
    f("inlinePolicies", "Inline Policies", { required: false, editable: false }),
    f("groups", "Groups", { required: false, editable: false }),
    f("accessKeyCount", "Access Keys", { kind: "number", required: false, editable: false }),
    f("isAdmin", "Administrator", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("arn", "ARN")],
  supportsCreate: true,
  supportsUpdate: true,
  credentialFormats: [
    {
      id: "access-key",
      label: "New access key",
      description: "Creates another access key for this user (IAM allows two per user).",
      mediaType: "ini",
      filenameTemplate: "wasabi-{resource}.ini",
    },
  ],
  principalRole: { role: "user", adminIndicatorKey: "isAdmin" },
  iconKey: "user",
});

export const AccessKeyResourceType = rt({
  id: "access-key",
  name: "Access Key",
  description:
    "An IAM user's access key: whether it is active, and when it was created and last used.",
  parentTypeId: "iam-user",
  showInSidebar: true,
  fields: [
    f("accessKeyId", "Access Key ID", { editable: false }),
    f("userName", "User", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
  ],
  outputs: [o("accessKeyId", "Access Key ID")],
  expiryFields: [
    {
      fieldKey: "createdAt",
      from: "created",
      kind: "access-key",
      label: "Access key due for rotation",
    },
  ],
  principalRole: { role: "key", parentKey: "userName", revokeActionId: "deactivate" },
  pinnable: false,
  iconKey: "key",
});

export const SubAccountResourceType = rt({
  id: "sub-account",
  name: "Sub-Account",
  description:
    "A sub-account of a Wasabi Account Control (WAC) control account: trial state, quota, activation and daily usage. Needs the WAC API key.",
  fields: [
    f("acctNum", "Account Number", { kind: "number", editable: false }),
    f("acctName", "Root User Email", { editable: false }),
    f("isTrial", "Trial", { kind: "boolean", required: false, editable: false }),
    f("trialExpiry", "Trial Expires", { required: false, editable: false }),
    f("quotaGb", "Trial Quota (GB)", { kind: "number", required: false }),
    f("inactive", "Inactive", { kind: "boolean", required: false }),
    f("enableFtp", "FTP/FTPS", { kind: "boolean", required: false }),
    f("allowAccountDelete", "Can Delete Itself", { kind: "boolean", required: false }),
    f("mfa", "MFA Enabled", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("accessKey", "Root Access Key", {
      sensitive: true,
      description: "Only for sub-accounts created from Infrawrench.",
    }),
    o("secretKey", "Root Secret Key", {
      sensitive: true,
      description: "Only for sub-accounts created from Infrawrench.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  expiryFields: [{ fieldKey: "trialExpiry", from: "expiry", kind: "other", label: "Trial ends" }],
  iconKey: "account",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  BucketResourceType,
  LifecycleRuleResourceType,
  CorsRuleResourceType,
  IamUserResourceType,
  AccessKeyResourceType,
  SubAccountResourceType,
];
