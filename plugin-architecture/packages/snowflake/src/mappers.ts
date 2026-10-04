/**
 * SHOW output rows to `ResourceInstance`s. Rows arrive with lower-cased keys
 * from `runSql`; column names follow the SHOW row structs in the Snowflake
 * Terraform provider's SDK (v2.21.0, 2026-10).
 *
 * External ids are the object's name parts, each URI-encoded and joined
 * with a dot (`DB.SCHEMA.TASK`), so a quoted identifier containing a dot or
 * a colon still round-trips.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { bool, num, str } from "./api.js";
import { findSize } from "./catalog.js";
import { TYPE } from "./resource-types.js";

export const PLUGIN_ID = "snowflake";

type FieldValue = string | number | boolean | undefined | null;
type Row = Record<string, unknown>;

export function encodeId(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p).replace(/\./g, "%2E")).join(".");
}

export function decodeId(externalId: string): string[] {
  return externalId.split(".").map((p) => decodeURIComponent(p));
}

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
  parentExternal?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    ...(parentExternal
      ? { parentResourceId: `${accountId}:${parentExternal.typeId}:${parentExternal.externalId}` }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Timestamps from the decoder are already ISO; anything else passes through. */
const time = (v: unknown): string | undefined => {
  const s = str(v);
  return s || undefined;
};

/** SHOW options strings such as "TRANSIENT, MANAGED ACCESS". */
const hasOption = (row: Row, option: string): boolean =>
  str(row["options"])
    .toUpperCase()
    .split(",")
    .map((s) => s.trim())
    .includes(option);

export function mapWarehouse(accountId: string, row: Row, credits30d?: number): ResourceInstance {
  const name = str(row["name"]);
  const autoSuspend = num(row["auto_suspend"]);
  const size = findSize(str(row["size"]));
  return instance(
    accountId,
    TYPE.warehouse,
    encodeId(name),
    name,
    {
      name,
      size: size?.show ?? str(row["size"]),
      autoSuspend: autoSuspend ?? 0,
      autoSuspendNever: autoSuspend === undefined || autoSuspend === 0,
      autoResume: bool(row["auto_resume"]),
      minClusterCount: num(row["min_cluster_count"]),
      maxClusterCount: num(row["max_cluster_count"]),
      scalingPolicy: str(row["scaling_policy"]),
      queryAcceleration: bool(row["enable_query_acceleration"]),
      comment: str(row["comment"]),
      state: str(row["state"]).toUpperCase(),
      type: str(row["type"]),
      resourceMonitor: str(row["resource_monitor"]) === "null" ? "" : str(row["resource_monitor"]),
      running: num(row["running"]),
      queued: num(row["queued"]),
      startedClusters: num(row["started_clusters"]),
      generation: str(row["generation"]),
      credits30d: credits30d !== undefined ? Math.round(credits30d * 100) / 100 : undefined,
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
      resumedOn: time(row["resumed_on"]),
    },
    { name },
  );
}

export function mapDatabase(
  accountId: string,
  row: Row,
  storage?: { bytes: number; failsafe: number },
): ResourceInstance {
  const name = str(row["name"]);
  return instance(
    accountId,
    TYPE.database,
    encodeId(name),
    name,
    {
      name,
      retentionTime: num(row["retention_time"]),
      comment: str(row["comment"]),
      kind: str(row["kind"]) || (hasOption(row, "TRANSIENT") ? "TRANSIENT" : "STANDARD"),
      origin: str(row["origin"]),
      storageBytes: storage?.bytes,
      failsafeBytes: storage?.failsafe,
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { name },
  );
}

export function mapSchema(accountId: string, row: Row): ResourceInstance {
  const name = str(row["name"]);
  const database = str(row["database_name"]);
  return instance(
    accountId,
    TYPE.schema,
    encodeId(database, name),
    name,
    {
      name,
      database,
      retentionTime: num(row["retention_time"]),
      comment: str(row["comment"]),
      managedAccess: hasOption(row, "MANAGED ACCESS"),
      transient: hasOption(row, "TRANSIENT"),
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { qualifiedName: `${database}.${name}` },
    { typeId: TYPE.database, externalId: encodeId(database) },
  );
}

/** "75%,90%" (SHOW RESOURCE MONITORS) to [75, 90]. */
export function parsePercents(raw: unknown): number[] {
  return str(raw)
    .split(",")
    .map((s) => Number(s.replace(/%/g, "").trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function mapResourceMonitor(
  accountId: string,
  row: Row,
  warehouses: string[] = [],
): ResourceInstance {
  const name = str(row["name"]);
  const suspendAt = parsePercents(row["suspend_at"])[0];
  const suspendImmediatelyAt = parsePercents(row["suspend_immediately_at"])[0];
  return instance(
    accountId,
    TYPE.resourceMonitor,
    encodeId(name),
    name,
    {
      name,
      creditQuota: num(row["credit_quota"]),
      frequency: str(row["frequency"]).toUpperCase(),
      notifyAt: parsePercents(row["notify_at"]).join(","),
      suspendAt,
      suspendImmediatelyAt,
      usedCredits: num(row["used_credits"]),
      remainingCredits: num(row["remaining_credits"]),
      level: str(row["level"]),
      warehouses: warehouses.join(", "),
      startTime: time(row["start_time"]),
      endTime: time(row["end_time"]),
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { name },
  );
}

export function mapUser(accountId: string, row: Row): ResourceInstance {
  const name = str(row["name"]);
  return instance(
    accountId,
    TYPE.user,
    encodeId(name),
    str(row["display_name"]) || name,
    {
      name,
      defaultRole: str(row["default_role"]),
      defaultWarehouse: str(row["default_warehouse"]),
      comment: str(row["comment"]),
      loginName: str(row["login_name"]),
      displayName: str(row["display_name"]),
      email: str(row["email"]),
      type: str(row["type"]),
      disabled: bool(row["disabled"]),
      hasPassword: bool(row["has_password"]),
      hasRsaPublicKey: bool(row["has_rsa_public_key"]),
      hasMfa: bool(row["has_mfa"]),
      lastSuccessLogin: time(row["last_success_login"]),
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { loginName: str(row["login_name"]) },
  );
}

export function mapRole(accountId: string, row: Row): ResourceInstance {
  const name = str(row["name"]);
  return instance(
    accountId,
    TYPE.role,
    encodeId(name),
    name,
    {
      name,
      comment: str(row["comment"]),
      assignedToUsers: num(row["assigned_to_users"]),
      grantedToRoles: num(row["granted_to_roles"]),
      grantedRoles: num(row["granted_roles"]),
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { name },
  );
}

function schemaObject(row: Row) {
  const name = str(row["name"]);
  const database = str(row["database_name"]);
  const schema = str(row["schema_name"]);
  return {
    name,
    database,
    schema,
    externalId: encodeId(database, schema, name),
    qualifiedName: `${database}.${schema}.${name}`,
  };
}

/** SHOW TASKS prints predecessors as a JSON array of qualified names. */
function predecessors(raw: unknown): string {
  const s = str(raw);
  if (!s.startsWith("[")) return s;
  try {
    const list = JSON.parse(s) as unknown[];
    return list.map((p) => String(p).replace(/"/g, "")).join(", ");
  } catch {
    return s;
  }
}

const truncate = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function mapTask(accountId: string, row: Row): ResourceInstance {
  const o = schemaObject(row);
  return instance(
    accountId,
    TYPE.task,
    o.externalId,
    o.name,
    {
      name: o.name,
      database: o.database,
      schema: o.schema,
      schedule: str(row["schedule"]),
      comment: str(row["comment"]),
      state: str(row["state"]).toLowerCase(),
      warehouse: str(row["warehouse"]),
      predecessors: predecessors(row["predecessors"]),
      condition: str(row["condition"]),
      definition: truncate(str(row["definition"])),
      lastSuspendedReason: str(row["last_suspended_reason"]),
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { qualifiedName: o.qualifiedName },
  );
}

export function mapPipe(
  accountId: string,
  row: Row,
  status?: { executionState?: string; pendingFileCount?: number; lastIngested?: string },
): ResourceInstance {
  const o = schemaObject(row);
  return instance(
    accountId,
    TYPE.pipe,
    o.externalId,
    o.name,
    {
      name: o.name,
      database: o.database,
      schema: o.schema,
      comment: str(row["comment"]),
      executionState: status?.executionState,
      pendingFileCount: status?.pendingFileCount,
      lastIngested: status?.lastIngested,
      definition: truncate(str(row["definition"])),
      notificationChannel: str(row["notification_channel"]),
      integration: str(row["integration"]),
      pattern: str(row["pattern"]),
      invalidReason: str(row["invalid_reason"]),
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { qualifiedName: o.qualifiedName },
  );
}

export function mapDynamicTable(accountId: string, row: Row): ResourceInstance {
  const o = schemaObject(row);
  return instance(
    accountId,
    TYPE.dynamicTable,
    o.externalId,
    o.name,
    {
      name: o.name,
      database: o.database,
      schema: o.schema,
      targetLag: str(row["target_lag"]),
      comment: str(row["comment"]),
      schedulingState: str(row["scheduling_state"]),
      refreshMode: str(row["refresh_mode"]),
      warehouse: str(row["warehouse"]),
      rows: num(row["rows"]),
      bytes: num(row["bytes"]),
      dataTimestamp: time(row["data_timestamp"]),
      owner: str(row["owner"]),
      createdOn: time(row["created_on"]),
    },
    { qualifiedName: o.qualifiedName },
  );
}
