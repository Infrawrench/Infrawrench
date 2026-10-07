import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  B2Bucket,
  B2CorsRule,
  B2Key,
  B2LifecycleRule,
  B2NotificationRule,
  B2ReplicationRule,
} from "./types.js";
import { truthy, unwrapReplication } from "./types.js";

export const PLUGIN_ID = "backblaze-b2";

type Fields = Record<string, string | number | boolean>;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  parentExternalId?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parentExternalId
      ? {
          parentResourceId: `${accountId}:${parentExternalId.typeId}:${parentExternalId.externalId}`,
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Split `{bucketId}/{rest}` child ids; the rest may itself contain slashes. */
export function splitChildId(externalId: string): { bucketId: string; key: string } {
  const i = externalId.indexOf("/");
  if (i < 0) return { bucketId: externalId, key: "" };
  return { bucketId: externalId.slice(0, i), key: externalId.slice(i + 1) };
}

/** Retention period in days; years are converted at 365 days. */
export function retentionDays(
  period: { duration?: number; unit?: string } | null | undefined,
): number | undefined {
  if (!period?.duration) return undefined;
  return period.unit === "years" ? period.duration * 365 : period.duration;
}

export interface BucketContext {
  s3Region: string;
  region: string;
}

export function bucketFields(b: B2Bucket, ctx: BucketContext): Fields {
  const lock = b.fileLockConfiguration?.value ?? undefined;
  const lockReadable = b.fileLockConfiguration?.isClientAuthorizedToRead;
  const sse = b.defaultServerSideEncryption?.value ?? undefined;
  const sseReadable = b.defaultServerSideEncryption?.isClientAuthorizedToRead;
  const repl = unwrapReplication(b.replicationConfiguration);
  const info = b.bucketInfo ?? {};
  const cacheControl =
    Object.entries(info).find(([k]) => k.toLowerCase() === "cache-control")?.[1] ?? "";
  const fields: Fields = {
    name: b.bucketName,
    bucketId: b.bucketId,
    bucketType: b.bucketType,
    region: ctx.region,
    s3Region: ctx.s3Region,
    lifecycleRuleCount: (b.lifecycleRules ?? []).length,
    corsRuleCount: (b.corsRules ?? []).length,
    replicationRuleCount: (repl.asReplicationSource?.replicationRules ?? []).length,
    isReplicationDestination:
      Object.keys(repl.asReplicationDestination?.sourceToDestinationKeyMapping ?? {}).length > 0,
    options: (b.options ?? []).join(", "),
    bucketInfo: JSON.stringify(info),
    lifecycleRulesJson: JSON.stringify(b.lifecycleRules ?? []),
    corsRulesJson: JSON.stringify(b.corsRules ?? []),
    cacheControl,
  };
  if (b.revision !== undefined && Number.isFinite(Number(b.revision))) {
    fields["revision"] = Number(b.revision);
  }
  // Settings the key may not read come back with isClientAuthorizedToRead
  // false and no value: leave the field absent rather than claim "off".
  if (sseReadable === undefined || truthy(sseReadable)) {
    fields["encryption"] = sse?.mode ? String(sse.mode) : "none";
  }
  if (lockReadable === undefined || truthy(lockReadable)) {
    fields["objectLock"] = truthy(lock?.isFileLockEnabled);
    const mode = lock?.defaultRetention?.mode;
    fields["retentionMode"] = mode ? String(mode) : "none";
    const days = retentionDays(lock?.defaultRetention?.period);
    if (days !== undefined) fields["retentionDays"] = days;
  }
  return fields;
}

export function bucketInstance(
  accountId: string,
  b: B2Bucket,
  ctx: BucketContext,
): ResourceInstance {
  return instance(accountId, "bucket", b.bucketId, b.bucketName, bucketFields(b, ctx));
}

export function lifecycleKey(rule: B2LifecycleRule): string {
  return rule.fileNamePrefix ?? "";
}

export function lifecycleInstance(
  accountId: string,
  b: B2Bucket,
  rule: B2LifecycleRule,
): ResourceInstance {
  const prefix = lifecycleKey(rule);
  const fields: Fields = { bucketId: b.bucketId, bucketName: b.bucketName, fileNamePrefix: prefix };
  for (const k of [
    "daysFromUploadingToHiding",
    "daysFromHidingToDeleting",
    "daysFromStartingToCancelingUnfinishedLargeFiles",
  ] as const) {
    const v = rule[k];
    if (typeof v === "number") fields[k] = v;
  }
  return instance(
    accountId,
    "lifecycle-rule",
    `${b.bucketId}/${prefix}`,
    prefix ? `${b.bucketName}/${prefix}*` : `${b.bucketName} (all files)`,
    fields,
    { typeId: "bucket", externalId: b.bucketId },
  );
}

export function corsInstance(accountId: string, b: B2Bucket, rule: B2CorsRule): ResourceInstance {
  return instance(
    accountId,
    "cors-rule",
    `${b.bucketId}/${rule.corsRuleName}`,
    rule.corsRuleName,
    {
      bucketId: b.bucketId,
      bucketName: b.bucketName,
      corsRuleName: rule.corsRuleName,
      allowedOrigins: (rule.allowedOrigins ?? []).join(", "),
      allowedOperations: (rule.allowedOperations ?? []).join(", "),
      allowedHeaders: (rule.allowedHeaders ?? []).join(", "),
      exposeHeaders: (rule.exposeHeaders ?? []).join(", "),
      maxAgeSeconds: rule.maxAgeSeconds ?? 0,
    },
    { typeId: "bucket", externalId: b.bucketId },
  );
}

export function replicationInstance(
  accountId: string,
  b: B2Bucket,
  rule: B2ReplicationRule,
  bucketNames: Map<string, string>,
): ResourceInstance {
  return instance(
    accountId,
    "replication-rule",
    `${b.bucketId}/${rule.replicationRuleName}`,
    rule.replicationRuleName,
    {
      bucketId: b.bucketId,
      bucketName: b.bucketName,
      replicationRuleName: rule.replicationRuleName,
      destinationBucketId: rule.destinationBucketId,
      destinationBucketName: bucketNames.get(rule.destinationBucketId) ?? "",
      fileNamePrefix: rule.fileNamePrefix ?? "",
      priority: rule.priority ?? 1,
      isEnabled: rule.isEnabled !== false,
      includeExistingFiles: rule.includeExistingFiles === true,
    },
    { typeId: "bucket", externalId: b.bucketId },
  );
}

export function headersToString(
  h: Array<{ name: string; value: string }> | null | undefined,
): string {
  return (h ?? []).map((x) => `${x.name}=${x.value}`).join(", ");
}

export function parseHeaders(raw: string): Array<{ name: string; value: string }> {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq <= 0) throw new Error(`"${p}" is not a Name=Value header.`);
      return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
    });
}

export function notificationInstance(
  accountId: string,
  bucketId: string,
  bucketName: string,
  rule: B2NotificationRule,
): ResourceInstance {
  return instance(
    accountId,
    "notification-rule",
    `${bucketId}/${rule.name}`,
    rule.name,
    {
      bucketId,
      bucketName,
      name: rule.name,
      url: rule.targetConfiguration?.url ?? "",
      eventTypes: (rule.eventTypes ?? []).join(", "),
      objectNamePrefix: rule.objectNamePrefix ?? "",
      isEnabled: rule.isEnabled !== false,
      maxEventsPerBatch: rule.maxEventsPerBatch ?? 1,
      customHeaders: headersToString(rule.targetConfiguration?.customHeaders),
      isSuspended: rule.isSuspended === true,
      suspensionReason: rule.suspensionReason ?? "",
    },
    { typeId: "bucket", externalId: bucketId },
  );
}

const ADMIN_CAPABILITIES = ["writeKeys", "deleteKeys", "deleteBuckets", "bypassGovernance"];

export function keyInstance(
  accountId: string,
  k: B2Key,
  bucketNames: Map<string, string>,
): ResourceInstance {
  const bucketIds = k.bucketIds ?? (k.bucketId ? [k.bucketId] : []);
  return instance(
    accountId,
    "application-key",
    k.applicationKeyId,
    k.keyName || k.applicationKeyId,
    {
      keyName: k.keyName,
      applicationKeyId: k.applicationKeyId,
      capabilities: (k.capabilities ?? []).join(", "),
      bucketIds: bucketIds.join(", "),
      bucketNames: bucketIds.map((id) => bucketNames.get(id) ?? id).join(", "),
      namePrefix: k.namePrefix ?? "",
      expiresAt: k.expirationTimestamp ? new Date(k.expirationTimestamp).toISOString() : "",
      isAdmin: (k.capabilities ?? []).some((c) => ADMIN_CAPABILITIES.includes(c)),
      options: (k.options ?? []).join(", "),
    },
  );
}

/** Comma/space separated list → trimmed unique values. */
export function splitList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** A `policy-picker` value is a JSON array; tolerate a comma list too. */
export function parsePicked(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return splitList(t);
}
