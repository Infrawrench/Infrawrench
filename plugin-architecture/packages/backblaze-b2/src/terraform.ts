import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import type { B2CorsRule, B2LifecycleRule } from "./types.js";
import { splitList } from "./mappers.js";

/**
 * Terraform mapping for the official `Backblaze/b2` provider (v0.14.0,
 * 2026-09-16; schemas from docs/resources/*.md in
 * github.com/Backblaze/terraform-provider-b2):
 * - `b2_bucket`: `bucket_name`, `bucket_type`, `bucket_info`, `cors_rules`,
 *   `lifecycle_rules`, `default_server_side_encryption`,
 *   `file_lock_configuration`. Lifecycle and CORS rules are emitted inline
 *   from the bucket, which is how the provider models them; the child rule
 *   types are therefore not separately exportable. Import id: the bucket id.
 * - `b2_application_key`: `key_name`, `capabilities`, `bucket_ids`,
 *   `name_prefix`. Every argument forces replacement, and the secret is only
 *   known to a fresh create.
 * Replication and notification rules are not mapped: replication needs the
 * source key's secret, and `b2_bucket_notification_rules` owns a bucket's
 * whole rule list, which one child resource cannot describe.
 */
export const b2TerraformExport: TerraformExportCapability = {
  provider: { name: "b2", source: "Backblaze/b2", version: "~> 0.14" },
  providerConfig: {
    application_key_id: tf.ref("var.b2_application_key_id"),
    application_key: tf.ref("var.b2_application_key"),
  },
  variables: [
    { name: "b2_application_key_id", description: "Backblaze B2 application key ID" },
    { name: "b2_application_key", description: "Backblaze B2 application key", sensitive: true },
  ],
  supportedResourceTypeIds: ["bucket", "application-key"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "bucket":
        return mapBucket(resource);
      case "application-key": {
        const keyName = fieldString(resource, "keyName");
        const capabilities = splitList(fieldString(resource, "capabilities"));
        if (!keyName || capabilities.length === 0) return null;
        const attributes: Record<string, TerraformValue> = {
          key_name: tf.str(keyName),
          capabilities: tf.list(capabilities.map(tf.str)),
        };
        const bucketIds = splitList(fieldString(resource, "bucketIds"));
        if (bucketIds.length > 0) attributes["bucket_ids"] = tf.list(bucketIds.map(tf.str));
        const prefix = fieldString(resource, "namePrefix");
        if (prefix) attributes["name_prefix"] = tf.str(prefix);
        return {
          resource: {
            type: "b2_application_key",
            name: keyName,
            attributes,
            comments: [
              "The provider cannot import an existing key: applying this creates a new key with a new secret.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};

/**
 * A `dynamic` block over a list of objects: the serializer writes one key per
 * attribute, so a repeated block (several CORS or lifecycle rules) is
 * expressed as `for_each` over object literals with a `content` block that
 * reads each attribute back.
 */
export function dynamicBlock(
  name: string,
  items: Array<Record<string, TerraformValue>>,
): TerraformValue {
  const keys = Object.keys(items[0] ?? {});
  return tf.block({
    for_each: tf.list(items.map((item) => tf.map(item))),
    content: tf.block(Object.fromEntries(keys.map((k) => [k, tf.ref(`${name}.value.${k}`)]))),
  });
}

function parseJson<T>(raw: string): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function mapBucket(
  resource: Parameters<TerraformExportCapability["mapResource"]>[0],
): TerraformExportResult | null {
  const name = fieldString(resource, "name") || resource.displayName;
  const type = fieldString(resource, "bucketType");
  if (!name || (type !== "allPrivate" && type !== "allPublic")) return null;
  const attributes: Record<string, TerraformValue> = {
    bucket_name: tf.str(name),
    bucket_type: tf.str(type),
  };
  const info = parseJson<Record<string, string>>(fieldString(resource, "bucketInfo"));
  if (info && Object.keys(info).length > 0) {
    attributes["bucket_info"] = tf.map(
      Object.fromEntries(Object.entries(info).map(([k, v]) => [k, tf.str(String(v))])),
    );
  }
  const cors = parseJson<B2CorsRule[]>(fieldString(resource, "corsRulesJson")) ?? [];
  if (cors.length > 0) {
    attributes['dynamic "cors_rules"'] = dynamicBlock(
      "cors_rules",
      cors.map((r) => ({
        cors_rule_name: tf.str(r.corsRuleName),
        allowed_origins: tf.list((r.allowedOrigins ?? []).map(tf.str)),
        allowed_operations: tf.list((r.allowedOperations ?? []).map(tf.str)),
        allowed_headers: tf.list((r.allowedHeaders ?? []).map(tf.str)),
        expose_headers: tf.list((r.exposeHeaders ?? []).map(tf.str)),
        max_age_seconds: tf.num(r.maxAgeSeconds ?? 0),
      })),
    );
  }
  const lifecycle = parseJson<B2LifecycleRule[]>(fieldString(resource, "lifecycleRulesJson")) ?? [];
  if (lifecycle.length > 0) {
    const days = (v: number | null | undefined): TerraformValue =>
      typeof v === "number" ? tf.num(v) : tf.ref("null");
    attributes['dynamic "lifecycle_rules"'] = dynamicBlock(
      "lifecycle_rules",
      lifecycle.map((r) => ({
        file_name_prefix: tf.str(r.fileNamePrefix ?? ""),
        days_from_hiding_to_deleting: days(r.daysFromHidingToDeleting),
        days_from_uploading_to_hiding: days(r.daysFromUploadingToHiding),
        days_from_starting_to_canceling_unfinished_large_files: days(
          r.daysFromStartingToCancelingUnfinishedLargeFiles,
        ),
      })),
    );
  }
  if (fieldString(resource, "encryption") === "SSE-B2") {
    attributes["default_server_side_encryption"] = tf.block({
      mode: tf.str("SSE-B2"),
      algorithm: tf.str("AES256"),
    });
  }
  if (fieldBool(resource, "objectLock")) {
    const lock: Record<string, TerraformValue> = { is_file_lock_enabled: tf.bool(true) };
    const mode = fieldString(resource, "retentionMode");
    const days = fieldNumber(resource, "retentionDays");
    if (mode && mode !== "none" && days) {
      lock["default_retention"] = tf.block({
        mode: tf.str(mode),
        period: tf.block({ duration: tf.num(days), unit: tf.str("days") }),
      });
    }
    attributes["file_lock_configuration"] = tf.block(lock);
  }
  return {
    resource: {
      type: "b2_bucket",
      name,
      attributes,
      importId: resource.externalId,
    },
  };
}
