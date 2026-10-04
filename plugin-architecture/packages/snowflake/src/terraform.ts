import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";
import { findSize } from "./catalog.js";
import { decodeId } from "./mappers.js";
import { TYPE } from "./resource-types.js";

/**
 * Terraform mapping for Snowflake: provider `snowflakedb/snowflake`.
 *
 * Attribute names and import ids verified against the provider's own docs
 * (snowflakedb/terraform-provider-snowflake `docs/resources/{warehouse,
 * database,schema,resource_monitor}.md` and `docs/index.md`, v2.21.0,
 * 2026-10). Import ids are quoted identifiers: `'"<name>"'`, and
 * `'"<database>"."<schema>"'` for schemas. The provider authenticates with
 * `organization_name`, `account_name`, `user`, `authenticator =
 * "SNOWFLAKE_JWT"` and `private_key`.
 */

const quoted = (...parts: string[]) => parts.map((p) => `"${p.replace(/"/g, '""')}"`).join(".");

function numberAttr(raw: string): TerraformValue | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? tf.num(n) : undefined;
}

export const snowflakeTerraformExport: TerraformExportCapability = {
  provider: { name: "snowflake", source: "snowflakedb/snowflake", version: "~> 2.0" },
  providerConfig: {
    organization_name: tf.ref("var.snowflake_organization_name"),
    account_name: tf.ref("var.snowflake_account_name"),
    user: tf.ref("var.snowflake_user"),
    authenticator: tf.str("SNOWFLAKE_JWT"),
    private_key: tf.ref("var.snowflake_private_key"),
  },
  variables: [
    { name: "snowflake_organization_name", description: "Snowflake organization name" },
    { name: "snowflake_account_name", description: "Snowflake account name" },
    { name: "snowflake_user", description: "User the key pair belongs to" },
    { name: "snowflake_private_key", description: "PEM private key", sensitive: true },
  ],
  supportedResourceTypeIds: [TYPE.warehouse, TYPE.database, TYPE.schema, TYPE.resourceMonitor],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const comment = fieldString(resource, "comment");
    const attributes: Record<string, TerraformValue> = {};
    switch (resource.resourceTypeId) {
      case TYPE.warehouse: {
        attributes["name"] = tf.str(name);
        const size = findSize(fieldString(resource, "size"));
        if (size) attributes["warehouse_size"] = tf.str(size.sql);
        const autoSuspend = numberAttr(fieldString(resource, "autoSuspend"));
        if (autoSuspend && fieldString(resource, "autoSuspend") !== "0") {
          attributes["auto_suspend"] = autoSuspend;
        }
        const autoResume = fieldString(resource, "autoResume");
        if (autoResume)
          attributes["auto_resume"] = tf.str(autoResume === "true" ? "true" : "false");
        const min = numberAttr(fieldString(resource, "minClusterCount"));
        const max = numberAttr(fieldString(resource, "maxClusterCount"));
        if (max) attributes["max_cluster_count"] = max;
        if (min) attributes["min_cluster_count"] = min;
        const monitor = fieldString(resource, "resourceMonitor");
        if (monitor) attributes["resource_monitor"] = tf.str(monitor);
        if (comment) attributes["comment"] = tf.str(comment);
        return {
          resource: {
            type: "snowflake_warehouse",
            name,
            attributes,
            importId: quoted(name),
          },
        };
      }
      case TYPE.database: {
        attributes["name"] = tf.str(name);
        attributes["is_transient"] = tf.bool(fieldString(resource, "kind") === "TRANSIENT");
        const retention = numberAttr(fieldString(resource, "retentionTime"));
        if (retention) attributes["data_retention_time_in_days"] = retention;
        if (comment) attributes["comment"] = tf.str(comment);
        return {
          resource: {
            type: "snowflake_database",
            name,
            attributes,
            importId: quoted(name),
            comments: ["Set is_transient explicitly before import to avoid a replacement plan."],
          },
        };
      }
      case TYPE.schema: {
        const [database] = decodeId(resource.externalId ?? "");
        const db = fieldString(resource, "database") || database || "";
        if (!db) return null;
        attributes["database"] = tf.str(db);
        attributes["name"] = tf.str(name);
        attributes["with_managed_access"] = tf.str(
          fieldString(resource, "managedAccess") === "true" ? "true" : "false",
        );
        attributes["is_transient"] = tf.str(
          fieldString(resource, "transient") === "true" ? "true" : "false",
        );
        if (comment) attributes["comment"] = tf.str(comment);
        return {
          resource: {
            type: "snowflake_schema",
            name: `${db}_${name}`,
            attributes,
            importId: quoted(db, name),
          },
        };
      }
      case TYPE.resourceMonitor: {
        attributes["name"] = tf.str(name);
        const quota = numberAttr(fieldString(resource, "creditQuota"));
        if (quota) attributes["credit_quota"] = quota;
        const frequency = fieldString(resource, "frequency");
        if (frequency) attributes["frequency"] = tf.str(frequency);
        const notify = fieldString(resource, "notifyAt")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (notify.length > 0)
          attributes["notify_triggers"] = tf.list(notify.map((n) => tf.num(n)));
        const suspend = numberAttr(fieldString(resource, "suspendAt"));
        if (suspend) attributes["suspend_trigger"] = suspend;
        const immediate = numberAttr(fieldString(resource, "suspendImmediatelyAt"));
        if (immediate) attributes["suspend_immediate_trigger"] = immediate;
        return {
          resource: {
            type: "snowflake_resource_monitor",
            name,
            attributes,
            importId: quoted(name),
            comments: [
              "start_timestamp and notify_users are not carried over; warehouse assignment lives",
              "on snowflake_warehouse.resource_monitor.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
