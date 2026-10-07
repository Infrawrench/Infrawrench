/**
 * B2 Native API v4 shapes, as documented on the per-operation pages of
 * https://www.backblaze.com/apidocs (verified 2026-10). Several booleans come
 * back as the strings "true"/"false" (`isClientAuthorizedToRead`,
 * `isFileLockEnabled` in the published examples), so readers go through
 * {@link truthy}.
 */

export interface B2CorsRule {
  corsRuleName: string;
  allowedOrigins: string[];
  allowedOperations: string[];
  allowedHeaders?: string[];
  exposeHeaders?: string[];
  maxAgeSeconds: number;
}

export interface B2LifecycleRule {
  fileNamePrefix: string;
  daysFromUploadingToHiding?: number | null;
  daysFromHidingToDeleting?: number | null;
  daysFromStartingToCancelingUnfinishedLargeFiles?: number | null;
}

export interface B2Retention {
  mode?: string | null;
  period?: { duration?: number; unit?: string } | null;
}

export interface B2ReplicationRule {
  replicationRuleName: string;
  destinationBucketId: string;
  fileNamePrefix?: string;
  priority?: number;
  isEnabled?: boolean;
  includeExistingFiles?: boolean;
}

export interface B2ReplicationConfiguration {
  asReplicationSource?: {
    sourceApplicationKeyId?: string;
    replicationRules?: B2ReplicationRule[];
  } | null;
  asReplicationDestination?: {
    sourceToDestinationKeyMapping?: Record<string, string>;
  } | null;
}

/** Sensitive bucket settings are wrapped: `{isClientAuthorizedToRead, value}`. */
export interface B2Guarded<T> {
  isClientAuthorizedToRead?: boolean | string;
  value?: T | null;
}

export interface B2Bucket {
  accountId: string;
  bucketId: string;
  bucketName: string;
  bucketType: string;
  bucketInfo?: Record<string, string>;
  corsRules?: B2CorsRule[];
  lifecycleRules?: B2LifecycleRule[];
  fileLockConfiguration?: B2Guarded<{
    isFileLockEnabled?: boolean | string | null;
    defaultRetention?: B2Retention | null;
  }>;
  defaultServerSideEncryption?: B2Guarded<{ mode?: string | null; algorithm?: string | null }>;
  /** Wrapped like the other guarded settings in list responses; tolerated bare. */
  replicationConfiguration?:
    (B2Guarded<B2ReplicationConfiguration> & B2ReplicationConfiguration) | null;
  revision?: number | string;
  options?: string[];
}

export interface B2Key {
  keyName: string;
  applicationKeyId: string;
  capabilities: string[];
  accountId: string;
  expirationTimestamp?: number | null;
  bucketIds?: string[] | null;
  /** v3 single-bucket keys report this instead of `bucketIds`. */
  bucketId?: string | null;
  namePrefix?: string | null;
  options?: string[];
}

export interface B2CreatedKey extends B2Key {
  applicationKey: string;
}

export interface B2NotificationRule {
  name: string;
  eventTypes: string[];
  isEnabled: boolean;
  isSuspended?: boolean;
  suspensionReason?: string;
  objectNamePrefix: string;
  maxEventsPerBatch?: number;
  targetConfiguration: {
    targetType: "webhook";
    url: string;
    hmacSha256SigningSecret?: string;
    customHeaders?: Array<{ name: string; value: string }> | null;
  };
}

export interface B2File {
  fileName: string;
  fileId?: string | null;
  contentLength?: number;
  contentType?: string | null;
  uploadTimestamp?: number;
  action?: "upload" | "folder" | "start" | "hide" | string;
}

export function truthy(v: unknown): boolean {
  return v === true || v === "true";
}

/** The guarded value, or the object itself when it was not wrapped. */
export function unwrapReplication(
  raw: B2Bucket["replicationConfiguration"],
): B2ReplicationConfiguration {
  if (!raw) return {};
  if (raw.value !== undefined) return raw.value ?? {};
  return {
    ...(raw.asReplicationSource ? { asReplicationSource: raw.asReplicationSource } : {}),
    ...(raw.asReplicationDestination
      ? { asReplicationDestination: raw.asReplicationDestination }
      : {}),
  };
}

/** Every capability `b2_create_key` accepts (b2-create-key, 2026-10). */
export const KEY_CAPABILITIES: Array<{ id: string; label: string; category: string }> = [
  { id: "listBuckets", label: "List buckets", category: "Buckets" },
  { id: "listAllBucketNames", label: "List all bucket names", category: "Buckets" },
  { id: "readBuckets", label: "Read bucket settings", category: "Buckets" },
  { id: "writeBuckets", label: "Create and change buckets", category: "Buckets" },
  { id: "deleteBuckets", label: "Delete buckets", category: "Buckets" },
  { id: "readBucketEncryption", label: "Read bucket encryption", category: "Buckets" },
  { id: "writeBucketEncryption", label: "Change bucket encryption", category: "Buckets" },
  { id: "readBucketRetentions", label: "Read Object Lock settings", category: "Buckets" },
  { id: "writeBucketRetentions", label: "Change Object Lock settings", category: "Buckets" },
  { id: "readBucketNotifications", label: "Read event notifications", category: "Buckets" },
  { id: "writeBucketNotifications", label: "Change event notifications", category: "Buckets" },
  { id: "readBucketLogging", label: "Read access logging", category: "Buckets" },
  { id: "writeBucketLogging", label: "Change access logging", category: "Buckets" },
  { id: "listFiles", label: "List files", category: "Files" },
  { id: "readFiles", label: "Download files", category: "Files" },
  { id: "shareFiles", label: "Share files (download authorizations)", category: "Files" },
  { id: "writeFiles", label: "Upload files", category: "Files" },
  { id: "deleteFiles", label: "Delete files", category: "Files" },
  { id: "readFileLegalHolds", label: "Read legal holds", category: "Files" },
  { id: "writeFileLegalHolds", label: "Change legal holds", category: "Files" },
  { id: "readFileRetentions", label: "Read file retention", category: "Files" },
  { id: "writeFileRetentions", label: "Change file retention", category: "Files" },
  { id: "bypassGovernance", label: "Bypass governance retention", category: "Files" },
  { id: "listKeys", label: "List application keys", category: "Keys" },
  { id: "writeKeys", label: "Create application keys", category: "Keys" },
  { id: "deleteKeys", label: "Delete application keys", category: "Keys" },
];

/** Event types a notification rule can match (event notifications reference, 2026-10). */
export const EVENT_TYPES: Array<{ id: string; label: string; category: string }> = [
  { id: "b2:ObjectCreated:*", label: "Any object created", category: "Object created" },
  { id: "b2:ObjectCreated:Upload", label: "Uploaded", category: "Object created" },
  {
    id: "b2:ObjectCreated:MultipartUpload",
    label: "Multipart upload finished",
    category: "Object created",
  },
  { id: "b2:ObjectCreated:Copy", label: "Copied", category: "Object created" },
  { id: "b2:ObjectCreated:Replica", label: "Replicated", category: "Object created" },
  {
    id: "b2:ObjectCreated:MultipartReplica",
    label: "Multipart replica",
    category: "Object created",
  },
  { id: "b2:ObjectDeleted:*", label: "Any object deleted", category: "Object deleted" },
  { id: "b2:ObjectDeleted:Delete", label: "Deleted", category: "Object deleted" },
  {
    id: "b2:ObjectDeleted:LifecycleRule",
    label: "Deleted by a lifecycle rule",
    category: "Object deleted",
  },
  { id: "b2:HideMarkerCreated:*", label: "Any hide marker", category: "Hide marker" },
  { id: "b2:HideMarkerCreated:Hide", label: "Hidden", category: "Hide marker" },
  {
    id: "b2:HideMarkerCreated:LifecycleRule",
    label: "Hidden by a lifecycle rule",
    category: "Hide marker",
  },
  {
    id: "b2:MultipartUploadCreated:LiveRead",
    label: "Live Read upload started",
    category: "Multipart",
  },
];

/**
 * CORS operations. The native names are verbatim from the CORS rules page;
 * the S3 ones are the `s3_*` spellings that page lists as "S3 Get Object" and
 * so on.
 */
export const CORS_OPERATIONS: Array<{ id: string; label: string; category: string }> = [
  { id: "s3_get", label: "S3 GetObject", category: "S3-compatible API" },
  { id: "s3_head", label: "S3 HeadObject", category: "S3-compatible API" },
  { id: "s3_put", label: "S3 PutObject", category: "S3-compatible API" },
  { id: "s3_delete", label: "S3 DeleteObject", category: "S3-compatible API" },
  { id: "b2_download_file_by_name", label: "Download by name", category: "Native API" },
  { id: "b2_download_file_by_id", label: "Download by id", category: "Native API" },
  { id: "b2_upload_file", label: "Upload file", category: "Native API" },
  { id: "b2_upload_part", label: "Upload part", category: "Native API" },
];
