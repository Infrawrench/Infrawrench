import type { ResourceInstance } from "@infrawrench/plugin-base";
import { formatGcpError, parseFormArg } from "./utils.js";

export interface FirestoreContext {
  project: string;
  token: () => Promise<string>;
}

export interface FirestoreIndexSummary {
  name: string;
  fullName: string;
  collectionGroup: string;
  queryScope: string;
  state: string;
  fieldsDesc: string;
}

export interface FirestoreBackupSchedule {
  name: string;
  fullName: string;
  retention: string;
  recurrence: string;
}

export interface FirestoreTtlConfig {
  fullName: string;
  collectionGroup: string;
  fieldPath: string;
  state: string;
}

export interface FirestoreOperation {
  id: string;
  fullName: string;
  kind: string;
  state: string;
  error: string;
}

export interface FirestoreRulesInfo {
  rulesetName: string;
  content: string;
  updateTime: string;
  error: string;
}

export interface FirestoreBackupInfo {
  name: string;
  fullName: string;
  snapshotTime: string;
  expireTime: string;
  state: string;
  sizeBytes: string;
}

export interface FirestoreDatabaseExtras {
  earliestVersionTime: string;
  versionRetentionPeriod: string;
  pointInTimeRecoveryEnablement: string;
}

export interface FirestoreUsageMetrics {
  reads24h: number;
  writes24h: number;
  deletes24h: number;
  storageBytes: number;
  available: boolean;
  /** When `available` is false, a short human-readable reason for the UI. */
  error: string;
}

interface FirestoreIamBinding {
  role: string;
  members: string[];
}

export interface FirestoreIamInfo {
  bindings: FirestoreIamBinding[];
  /** Policy etag — sent back on setIamPolicy for optimistic concurrency. */
  etag: string;
  error: string;
}

function googleApiErrorMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const msg = parsed.error?.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {
    // fall through
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

/**
 * True for project-level IAM roles that gate Firestore access — Datastore
 * roles (Firestore uses the legacy datastore.* role namespace), Firestore
 * roles, and Firebase Rules roles that govern security-rule deployment.
 */
function isFirestoreIamRole(role: string): boolean {
  return (
    role.startsWith("roles/datastore.") ||
    role.startsWith("roles/firestore.") ||
    role.startsWith("roles/firebaserules.")
  );
}

/**
 * List root collection IDs for a Firestore database. Paginates via
 * `pageToken` for Standard edition; for Enterprise edition the admin
 * backend rejects any `pageSize` / `pageToken` (returning 400 "Only 0 is
 * supported") and returns the full list in a single unpaginated call,
 * so we omit pagination fields there. Empty list for MongoDB-compatible
 * databases that don't expose documents via the REST API.
 */
export async function listFirestoreCollections(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<string[]> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  if (!dbId) return [];
  const isEnterprise = String(resource.fields["databaseEdition"] ?? "") === "ENTERPRISE";
  const tok = await ctx.token();
  const url = `https://firestore.googleapis.com/v1/projects/${p}/databases/${dbId}/documents:listCollectionIds`;
  const collected: string[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const body: Record<string, unknown> = isEnterprise ? {} : { pageSize: 100 };
    if (pageToken && !isEnterprise) body["pageToken"] = pageToken;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) return collected;
      throw new Error(`Firestore listCollectionIds ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { collectionIds?: string[]; nextPageToken?: string };
    for (const id of data.collectionIds ?? []) collected.push(id);
    if (isEnterprise || !data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return collected;
}

/**
 * List composite indexes across all collection groups for a database.
 *
 * Strategy: the Firestore admin API accepts `-` as a collection-group
 * wildcard, but this isn't documented behaviour and has been observed to
 * return an empty list in practice for some databases (notably Enterprise
 * edition). We fetch via the wildcard first; if it returns zero results
 * we fall back to iterating root collection ids and listing per-group.
 * Results are merged and de-duped by the index's full resource name.
 */
export async function listFirestoreIndexes(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreIndexSummary[]> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  if (!dbId) return [];
  const isEnterprise = String(resource.fields["databaseEdition"] ?? "") === "ENTERPRISE";
  const base = `https://firestore.googleapis.com/v1/projects/${p}/databases/${dbId}`;

  const byName = new Map<string, FirestoreIndexSummary>();
  const addAll = (summaries: FirestoreIndexSummary[]) => {
    for (const s of summaries) if (!byName.has(s.fullName)) byName.set(s.fullName, s);
  };

  try {
    addAll(await listFirestoreIndexesForGroup(ctx, base, "-", isEnterprise));
  } catch (e) {
    // The wildcard failed outright — fall through to per-collection
    // iteration. Don't surface the error yet; the fallback may succeed.
    console.warn("[firestore] wildcard indexes fetch failed:", e);
  }

  if (byName.size === 0) {
    const collections = await listFirestoreCollections(ctx, resource).catch(() => [] as string[]);
    const perGroup = await Promise.all(
      collections.map((c) =>
        listFirestoreIndexesForGroup(ctx, base, c, isEnterprise).catch((e) => {
          console.warn(`[firestore] indexes for collection ${c} failed:`, e);
          return [] as FirestoreIndexSummary[];
        }),
      ),
    );
    for (const list of perGroup) addAll(list);
  }

  return Array.from(byName.values());
}

/**
 * Fetch composite indexes for a single collection group (or the `-`
 * wildcard). Enterprise-edition databases reject `pageSize` / `pageToken`
 * on this endpoint (undocumented; error is `INVALID_ARGUMENT "Only 0 is
 * supported"`) so we skip pagination and rely on the server returning
 * everything in one response. gcloud's `firestore indexes composite list`
 * does the same.
 */
async function listFirestoreIndexesForGroup(
  ctx: FirestoreContext,
  base: string,
  collectionGroup: string,
  isEnterprise: boolean,
): Promise<FirestoreIndexSummary[]> {
  const tok = await ctx.token();
  const url = `${base}/collectionGroups/${encodeURIComponent(collectionGroup)}/indexes`;
  const collected: FirestoreIndexSummary[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const qs = new URLSearchParams();
    if (!isEnterprise) {
      qs.set("pageSize", "100");
      if (pageToken) qs.set("pageToken", pageToken);
    }
    const fullUrl = qs.toString() ? `${url}?${qs.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) {
      if (res.status === 404) return collected;
      throw new Error(`Firestore list indexes ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      indexes?: Array<{
        name?: string;
        queryScope?: string;
        state?: string;
        fields?: Array<{
          fieldPath?: string;
          order?: string;
          arrayConfig?: string;
        }>;
      }>;
      nextPageToken?: string;
    };
    for (const idx of data.indexes ?? []) {
      const fullName = idx.name ?? "";
      const parts = fullName.split("/");
      const cg = parts[parts.indexOf("collectionGroups") + 1] ?? "";
      const fieldsDesc = (idx.fields ?? [])
        .map((f) => {
          const suffix = f.arrayConfig ? ` ${f.arrayConfig}` : f.order ? ` ${f.order}` : "";
          return `${f.fieldPath ?? ""}${suffix}`;
        })
        .join(", ");
      collected.push({
        name: parts[parts.length - 1] ?? fullName,
        fullName,
        collectionGroup: cg,
        queryScope: idx.queryScope ?? "",
        state: idx.state ?? "",
        fieldsDesc,
      });
    }
    if (isEnterprise || !data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return collected;
}

export async function listFirestoreBackupSchedules(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreBackupSchedule[]> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  if (!dbId) return [];
  const tok = await ctx.token();
  const url = `https://firestore.googleapis.com/v1/projects/${p}/databases/${dbId}/backupSchedules`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`Firestore list backup schedules ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    backupSchedules?: Array<{
      name?: string;
      retention?: string;
      dailyRecurrence?: Record<string, never>;
      weeklyRecurrence?: { day?: string };
    }>;
  };
  return (data.backupSchedules ?? []).map((s) => {
    const fullName = s.name ?? "";
    const parts = fullName.split("/");
    return {
      name: parts[parts.length - 1] ?? "",
      fullName,
      retention: s.retention ?? "",
      recurrence: s.dailyRecurrence
        ? "Daily"
        : s.weeklyRecurrence
          ? `Weekly (${s.weeklyRecurrence.day ?? "?"})`
          : "—",
    };
  });
}

/**
 * List field-level TTL configurations for a Firestore database. Uses
 * the `collectionGroups/{id}/fields` endpoint filtered to fields with
 * `ttlConfig:*`. Enterprise edition rejects `pageSize`; see the
 * listFirestoreIndexesForGroup rationale.
 */
export async function listFirestoreTtlConfigs(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreTtlConfig[]> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  if (!dbId) return [];
  const isEnterprise = String(resource.fields["databaseEdition"] ?? "") === "ENTERPRISE";
  const base = `https://firestore.googleapis.com/v1/projects/${p}/databases/${dbId}`;
  const tok = await ctx.token();
  // Try the `-` wildcard first; fall back to iterating collections.
  const byName = new Map<string, FirestoreTtlConfig>();
  const fetchGroup = async (collectionGroup: string) => {
    const qs = new URLSearchParams({ filter: "ttlConfig:*" });
    if (!isEnterprise) qs.set("pageSize", "100");
    const url = `${base}/collectionGroups/${encodeURIComponent(collectionGroup)}/fields?${qs.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) return;
    const data = (await res.json()) as {
      fields?: Array<{ name?: string; ttlConfig?: { state?: string } }>;
    };
    for (const f of data.fields ?? []) {
      const fullName = f.name ?? "";
      if (!fullName) continue;
      const parts = fullName.split("/");
      const cg = parts[parts.indexOf("collectionGroups") + 1] ?? "";
      const fieldPath = parts[parts.length - 1] ?? "";
      if (!byName.has(fullName)) {
        byName.set(fullName, {
          fullName,
          collectionGroup: cg,
          fieldPath,
          state: f.ttlConfig?.state ?? "",
        });
      }
    }
  };

  try {
    await fetchGroup("-");
  } catch (e) {
    console.warn("[firestore] wildcard TTL fetch failed:", e);
  }
  if (byName.size === 0) {
    const collections = await listFirestoreCollections(ctx, resource).catch(() => [] as string[]);
    await Promise.all(
      collections.map((c) =>
        fetchGroup(c).catch((e) => {
          console.warn(`[firestore] TTL fetch for ${c} failed:`, e);
        }),
      ),
    );
  }
  return Array.from(byName.values());
}

/**
 * List the most recent long-running operations on the database.
 * Used on the Import/Export tab to show ongoing import/export status.
 */
export async function listFirestoreOperations(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreOperation[]> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  if (!dbId) return [];
  const tok = await ctx.token();
  const url = `https://firestore.googleapis.com/v1/projects/${p}/databases/${dbId}/operations`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    operations?: Array<{
      name?: string;
      done?: boolean;
      metadata?: { "@type"?: string; operationState?: string };
      error?: { message?: string };
    }>;
  };
  return (data.operations ?? []).slice(0, 10).map((op) => {
    const fullName = op.name ?? "";
    const parts = fullName.split("/");
    const id = parts[parts.length - 1] ?? fullName;
    const kindMatch = /(\w+Metadata)$/.exec(op.metadata?.["@type"] ?? "");
    return {
      id,
      fullName,
      kind: kindMatch ? (kindMatch[1] ?? "") : "",
      state: op.metadata?.operationState ?? (op.done ? "DONE" : "RUNNING"),
      error: op.error?.message ?? "",
    };
  });
}

/**
 * Fetch the currently deployed Firestore security rules for a database
 * via the Firebase Rules API. A "release" maps a human-readable name
 * (e.g. `cloud.firestore/hello`) to an immutable ruleset containing the
 * `firestore.rules` source text.
 */
export async function fetchFirestoreRules(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreRulesInfo> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  const empty: FirestoreRulesInfo = {
    rulesetName: "",
    content: "",
    updateTime: "",
    error: "",
  };
  if (!dbId) return empty;
  const tok = await ctx.token();
  // Default DB uses bare `cloud.firestore`; named DBs append the id.
  const releaseName =
    dbId === "(default)" ? "cloud.firestore" : `cloud.firestore/${encodeURIComponent(dbId)}`;
  try {
    const relRes = await fetch(
      `https://firebaserules.googleapis.com/v1/projects/${p}/releases/${releaseName}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!relRes.ok) {
      // 404 on the release just means no rules have ever been deployed
      // to this database — not really an error, show the empty-state
      // message instead.
      if (relRes.status === 404) return empty;
      return {
        ...empty,
        error: googleApiErrorMessage(await relRes.text()) || `HTTP ${relRes.status}`,
      };
    }
    const rel = (await relRes.json()) as {
      rulesetName?: string;
      updateTime?: string;
    };
    if (!rel.rulesetName) return empty;
    const rsRes = await fetch(`https://firebaserules.googleapis.com/v1/${rel.rulesetName}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!rsRes.ok) {
      return {
        ...empty,
        rulesetName: rel.rulesetName,
        error: googleApiErrorMessage(await rsRes.text()) || `HTTP ${rsRes.status}`,
      };
    }
    const rs = (await rsRes.json()) as {
      source?: { files?: Array<{ content?: string }> };
    };
    return {
      rulesetName: rel.rulesetName,
      content: rs.source?.files?.[0]?.content ?? "",
      updateTime: rel.updateTime ?? "",
      error: "",
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * List completed backups for a Firestore database. Backups live under
 * locations (not databases), so we query the wildcard location and filter
 * client-side by matching the `database` resource path.
 */
export async function listFirestoreBackups(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreBackupInfo[]> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  if (!dbId) return [];
  const tok = await ctx.token();
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${p}/locations/-/backups`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    backups?: Array<{
      name?: string;
      database?: string;
      snapshotTime?: string;
      expireTime?: string;
      state?: string;
      stats?: { sizeBytes?: string };
    }>;
  };
  const dbPath = `projects/${p}/databases/${dbId}`;
  return (data.backups ?? [])
    .filter((b) => (b.database ?? "").endsWith(dbPath))
    .map((b) => {
      const fullName = b.name ?? "";
      const parts = fullName.split("/");
      return {
        name: parts[parts.length - 1] ?? "",
        fullName,
        snapshotTime: b.snapshotTime ?? "",
        expireTime: b.expireTime ?? "",
        state: b.state ?? "",
        sizeBytes: b.stats?.sizeBytes ?? "",
      };
    });
}

/**
 * Re-fetch the database resource to pick up fields we don't normally
 * index in the lister — earliestVersionTime (PITR lower bound) and
 * versionRetentionPeriod (PITR window length).
 */
export async function fetchFirestoreDatabaseExtras(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreDatabaseExtras> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  const empty: FirestoreDatabaseExtras = {
    earliestVersionTime: "",
    versionRetentionPeriod: "",
    pointInTimeRecoveryEnablement: "",
  };
  if (!dbId) return empty;
  const tok = await ctx.token();
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${p}/databases/${encodeURIComponent(dbId)}`,
    { headers: { Authorization: `Bearer ${tok}` } },
  );
  if (!res.ok) return empty;
  const data = (await res.json()) as {
    earliestVersionTime?: string;
    versionRetentionPeriod?: string;
    pointInTimeRecoveryEnablement?: string;
  };
  return {
    earliestVersionTime: data.earliestVersionTime ?? "",
    versionRetentionPeriod: data.versionRetentionPeriod ?? "",
    pointInTimeRecoveryEnablement: data.pointInTimeRecoveryEnablement ?? "",
  };
}

/**
 * Fetch 24-hour usage totals from Cloud Monitoring: read / write / delete
 * counts plus current storage bytes. One `timeSeries.list` call per
 * metric. Swallows errors — returns `available: false` when Monitoring
 * refuses (missing permission, metric not yet reporting, etc.).
 */
export async function fetchFirestoreUsageMetrics(
  ctx: FirestoreContext,
  resource: ResourceInstance,
): Promise<FirestoreUsageMetrics> {
  const p = ctx.project;
  const dbId = String(resource.fields["name"] ?? "");
  const isEnterprise = String(resource.fields["databaseEdition"] ?? "") === "ENTERPRISE";
  const empty: FirestoreUsageMetrics = {
    reads24h: 0,
    writes24h: 0,
    deletes24h: 0,
    storageBytes: 0,
    available: false,
    error: "",
  };
  if (!dbId) return { ...empty, error: "no database id" };
  const tok = await ctx.token();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Firestore Enterprise edition publishes metrics exclusively against
  // the newer `firestore.googleapis.com/Database` monitored resource
  // and uses `_ops_count` metric names. Native-mode databases still
  // report under the legacy `firestore_instance` resource with
  // `_count` metric names. Mixing them yields "does not specify a
  // valid combination of metric and monitored resource descriptors".
  const resourceType = isEnterprise ? "firestore.googleapis.com/Database" : "firestore_instance";

  const fetchSum = async (metricType: string, aligner: string): Promise<number> => {
    const qs = new URLSearchParams();
    qs.set("interval.startTime", dayAgo.toISOString());
    qs.set("interval.endTime", now.toISOString());
    qs.set(
      "filter",
      `metric.type="${metricType}" AND resource.type="${resourceType}" AND resource.labels.database_id="${dbId}"`,
    );
    qs.set("aggregation.alignmentPeriod", "86400s");
    qs.set("aggregation.perSeriesAligner", aligner);
    qs.set("aggregation.crossSeriesReducer", "REDUCE_SUM");
    const res = await fetch(
      `https://monitoring.googleapis.com/v3/projects/${p}/timeSeries?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `${res.status} ${res.statusText}: ${googleApiErrorMessage(body) || body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as {
      timeSeries?: Array<{
        points?: Array<{
          value?: { int64Value?: string; doubleValue?: number };
        }>;
      }>;
    };
    let total = 0;
    for (const ts of data.timeSeries ?? []) {
      for (const pt of ts.points ?? []) {
        if (pt.value?.int64Value) total += Number(pt.value.int64Value);
        else if (typeof pt.value?.doubleValue === "number") total += pt.value.doubleValue;
      }
    }
    return total;
  };

  // Enterprise uses `*_ops_count`; Native uses `*_count`. Storage
  // bytes is not published for Enterprise via Monitoring — leave it
  // at 0 for now rather than firing a request that will 400.
  const readMetric = isEnterprise
    ? "firestore.googleapis.com/document/read_ops_count"
    : "firestore.googleapis.com/document/read_count";
  const writeMetric = isEnterprise
    ? "firestore.googleapis.com/document/write_ops_count"
    : "firestore.googleapis.com/document/write_count";
  const deleteMetric = isEnterprise
    ? "firestore.googleapis.com/document/delete_ops_count"
    : "firestore.googleapis.com/document/delete_count";

  const storagePromise: Promise<number> = isEnterprise
    ? Promise.resolve(0)
    : (async () => {
        try {
          return await fetchSum("firestore.googleapis.com/database/stored_bytes", "ALIGN_MEAN");
        } catch {
          return await fetchSum("firestore.googleapis.com/document/entity_size", "ALIGN_MEAN");
        }
      })();

  const results = await Promise.allSettled([
    fetchSum(readMetric, "ALIGN_SUM"),
    fetchSum(writeMetric, "ALIGN_SUM"),
    fetchSum(deleteMetric, "ALIGN_SUM"),
    storagePromise,
  ]);
  const [readsR, writesR, deletesR, storageR] = results;
  const firstError = results.find((r) => r.status === "rejected");
  const allFailed = results.every((r) => r.status === "rejected");
  if (allFailed && firstError && firstError.status === "rejected") {
    const msg =
      firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason);
    console.warn("[firestore] usage metrics fetch failed:", msg);
    return { ...empty, error: msg };
  }
  const pick = (r: (typeof results)[number]): number =>
    r.status === "fulfilled" ? Math.round(r.value) : 0;
  return {
    reads24h: pick(readsR),
    writes24h: pick(writesR),
    deletes24h: pick(deletesR),
    storageBytes: pick(storageR),
    available: true,
    error: "",
  };
}

/**
 * Fetch the project-level IAM policy and narrow it to the bindings that
 * govern Firestore access — Datastore roles, Firestore roles, and
 * Firebase Rules roles. Firestore does not expose per-database IAM; the
 * project policy is the source of truth.
 */
export async function fetchFirestoreIamBindings(ctx: FirestoreContext): Promise<FirestoreIamInfo> {
  const empty: FirestoreIamInfo = { bindings: [], etag: "", error: "" };
  const p = ctx.project;
  const tok = await ctx.token();
  const res = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${p}:getIamPolicy`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    return {
      ...empty,
      error: googleApiErrorMessage(body) || `HTTP ${res.status}`,
    };
  }
  const policy = (await res.json()) as {
    bindings?: Array<{ role: string; members?: string[]; condition?: unknown }>;
    etag?: string;
  };
  const relevant = (policy.bindings ?? []).filter((b) => isFirestoreIamRole(b.role));
  return {
    bindings: relevant.map((b) => ({
      role: b.role,
      members: (b.members ?? []).slice().sort(),
    })),
    etag: policy.etag ?? "",
    error: "",
  };
}

/**
 * Dispatcher for Firestore document-browser commands. `command` names are
 * MongoDB-style (listCollections, find, insertOne, deleteOne, etc.) for
 * UI consistency with MongoDocumentBrowser, but each resolves to the
 * equivalent Firestore REST operation.
 */
export async function executeFirestoreCommand(
  ctx: FirestoreContext,
  resourceId: string,
  _accountId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  // resourceId format: ${accountId}:firestore-database:${project}/${dbId}
  const marker = ":firestore-database:";
  const markerIdx = resourceId.indexOf(marker);
  if (markerIdx === -1) throw new Error("Invalid Firestore resource ID");
  const externalId = resourceId.slice(markerIdx + marker.length);
  const slashIdx = externalId.indexOf("/");
  if (slashIdx === -1) throw new Error("Malformed Firestore resource ID");
  const projectId = externalId.slice(0, slashIdx);
  const dbId = externalId.slice(slashIdx + 1);
  if (!dbId) throw new Error("Firestore database id is empty");
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(dbId)}`;

  switch (command) {
    case "listCollections": {
      return firestoreListCollections(ctx, base);
    }
    case "find": {
      const collection = String(args[0] ?? "");
      const skip = Number(args[1] ?? 0);
      const limit = Number(args[2] ?? 25);
      return firestoreFind(ctx, base, collection, skip, limit);
    }
    case "countDocuments": {
      const collection = String(args[0] ?? "");
      return firestoreCount(ctx, base, collection);
    }
    case "getDocument": {
      const docPath = String(args[0] ?? "");
      return firestoreGetDocument(ctx, base, docPath);
    }
    case "insertDocument": {
      const collection = String(args[0] ?? "");
      const docJson = String(args[1] ?? "{}");
      return firestoreInsertDocument(ctx, base, collection, docJson);
    }
    case "updateDocument": {
      const docPath = String(args[0] ?? "");
      const docJson = String(args[1] ?? "{}");
      return firestoreUpdateDocument(ctx, base, docPath, docJson);
    }
    case "deleteDocument": {
      const docPath = String(args[0] ?? "");
      return firestoreDeleteDocument(ctx, base, docPath);
    }
    case "deleteCollection": {
      const collection = String(args[0] ?? "");
      if (!collection) throw new Error("deleteCollection requires a collection name");
      return firestoreDeleteCollection(ctx, base, collection);
    }
    case "createIndex": {
      // Host passes form values as a single JSON-serialized object keyed
      // by the field.key from the action's `fields`.
      const vals = parseFormArg(args[0]);
      return firestoreCreateIndex(
        ctx,
        base,
        String(vals["collection"] ?? ""),
        String(vals["fields"] ?? "[]"),
        String(vals["queryScope"] ?? "COLLECTION"),
      );
    }
    case "deleteIndex": {
      const vals = parseFormArg(args[0]);
      return firestoreDeleteIndex(ctx, String(vals["indexName"] ?? ""));
    }
    case "createBackupSchedule": {
      const vals = parseFormArg(args[0]);
      return firestoreCreateBackupSchedule(
        ctx,
        base,
        String(vals["recurrence"] ?? "daily"),
        Number(vals["retentionSeconds"] ?? 604800),
        String(vals["weekDay"] ?? "MONDAY"),
      );
    }
    case "deleteBackupSchedule": {
      const vals = parseFormArg(args[0]);
      return firestoreDeleteBackupSchedule(ctx, String(vals["scheduleName"] ?? ""));
    }
    case "setTtl": {
      const vals = parseFormArg(args[0]);
      return firestoreSetTtl(
        ctx,
        base,
        String(vals["collectionGroup"] ?? ""),
        String(vals["fieldPath"] ?? ""),
      );
    }
    case "unsetTtl": {
      const vals = parseFormArg(args[0]);
      return firestoreUnsetTtl(ctx, String(vals["fieldFullName"] ?? ""));
    }
    case "exportDocuments": {
      const vals = parseFormArg(args[0]);
      return firestoreExportDocuments(
        ctx,
        base,
        String(vals["outputUri"] ?? ""),
        String(vals["collectionIds"] ?? ""),
      );
    }
    case "importDocuments": {
      const vals = parseFormArg(args[0]);
      return firestoreImportDocuments(
        ctx,
        base,
        String(vals["inputUri"] ?? ""),
        String(vals["collectionIds"] ?? ""),
      );
    }
    case "deployRules": {
      const vals = parseFormArg(args[0]);
      return firestoreDeployRules(ctx, dbId, String(vals["source"] ?? ""));
    }
    case "grantIamRole": {
      const vals = parseFormArg(args[0]);
      return firestoreGrantIamRole(ctx, String(vals["role"] ?? ""), String(vals["member"] ?? ""));
    }
    case "revokeIamMember": {
      const vals = parseFormArg(args[0]);
      // The table UI submits a single "binding" field encoded as
      // `role|member` so the modal only shows one dropdown. Earlier
      // per-role callers still pass separate `role` + `member` fields.
      const binding = String(vals["binding"] ?? "");
      const sep = binding.indexOf("|");
      const role = sep > 0 ? binding.slice(0, sep) : String(vals["role"] ?? "");
      const member = sep > 0 ? binding.slice(sep + 1) : String(vals["member"] ?? "");
      return firestoreRevokeIamMember(ctx, role, member);
    }
    default:
      throw new Error(`Firestore: unknown command "${command}"`);
  }
}

/**
 * Create a new ruleset containing the user-supplied source text, then
 * move the database's release pointer (`cloud.firestore` or
 * `cloud.firestore/{dbId}`) to point at it. Firebase Rules API
 * rulesets are immutable — deploying is always create-then-update-release.
 */
async function firestoreDeployRules(
  ctx: FirestoreContext,
  dbId: string,
  source: string,
): Promise<{ rulesetName?: string; releaseName?: string }> {
  if (!source.trim()) throw new Error("Rules source is empty");
  const p = ctx.project;
  const tok = await ctx.token();
  const createRes = await fetch(`https://firebaserules.googleapis.com/v1/projects/${p}/rulesets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { files: [{ name: "firestore.rules", content: source }] },
    }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Create ruleset: ${googleApiErrorMessage(body) || `HTTP ${createRes.status}`}`);
  }
  const ruleset = (await createRes.json()) as { name?: string };
  if (!ruleset.name) throw new Error("Create ruleset returned no name");

  const releaseShort =
    dbId === "(default)" ? "cloud.firestore" : `cloud.firestore/${encodeURIComponent(dbId)}`;
  const releaseFull = `projects/${p}/releases/${releaseShort}`;
  // Releases can only be PATCHed via updateMask when they already exist —
  // the first deployment has to go through POST /releases instead. Try
  // PATCH first and fall back to POST on 404.
  const patchRes = await fetch(`https://firebaserules.googleapis.com/v1/${releaseFull}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      release: { name: releaseFull, rulesetName: ruleset.name },
    }),
  });
  if (patchRes.ok) {
    return { rulesetName: ruleset.name, releaseName: releaseFull };
  }
  if (patchRes.status !== 404) {
    const body = await patchRes.text();
    throw new Error(`Update release: ${googleApiErrorMessage(body) || `HTTP ${patchRes.status}`}`);
  }
  const postRes = await fetch(`https://firebaserules.googleapis.com/v1/projects/${p}/releases`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: releaseFull, rulesetName: ruleset.name }),
  });
  if (!postRes.ok) {
    const body = await postRes.text();
    throw new Error(`Create release: ${googleApiErrorMessage(body) || `HTTP ${postRes.status}`}`);
  }
  return { rulesetName: ruleset.name, releaseName: releaseFull };
}

/**
 * Add a `member` to the existing binding for `role` on the project IAM
 * policy (or create the binding if it doesn't exist). Read-modify-write
 * on the whole policy; etag guards against concurrent edits.
 */
async function firestoreGrantIamRole(
  ctx: FirestoreContext,
  role: string,
  member: string,
): Promise<void> {
  if (!role || !member) throw new Error("Role and member are required");
  if (!isFirestoreIamRole(role)) {
    throw new Error(`Role ${role} is not a Firestore-related role`);
  }
  const p = ctx.project;
  const tok = await ctx.token();
  const crmBase = `https://cloudresourcemanager.googleapis.com/v1/projects/${p}`;
  const getRes = await fetch(`${crmBase}:getIamPolicy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
  });
  if (!getRes.ok) {
    throw new Error(await formatGcpError("Read project IAM policy", getRes));
  }
  const policy = (await getRes.json()) as {
    bindings?: Array<{ role: string; members?: string[]; condition?: unknown }>;
    etag?: string;
    version?: number;
  };
  const bindings = policy.bindings ?? [];
  const existing = bindings.find((b) => b.role === role && !b.condition);
  if (existing) {
    const members = existing.members ?? [];
    if (!members.includes(member)) members.push(member);
    existing.members = members;
  } else {
    bindings.push({ role, members: [member] });
  }
  const setRes = await fetch(`${crmBase}:setIamPolicy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ policy: { ...policy, bindings } }),
  });
  if (!setRes.ok) {
    throw new Error(await formatGcpError("Grant IAM role", setRes));
  }
}

/** Remove a member from a role binding; drops the binding entirely if empty. */
async function firestoreRevokeIamMember(
  ctx: FirestoreContext,
  role: string,
  member: string,
): Promise<void> {
  if (!role || !member) throw new Error("Role and member are required");
  const p = ctx.project;
  const tok = await ctx.token();
  const crmBase = `https://cloudresourcemanager.googleapis.com/v1/projects/${p}`;
  const getRes = await fetch(`${crmBase}:getIamPolicy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
  });
  if (!getRes.ok) {
    throw new Error(await formatGcpError("Read project IAM policy", getRes));
  }
  const policy = (await getRes.json()) as {
    bindings?: Array<{ role: string; members?: string[]; condition?: unknown }>;
    etag?: string;
    version?: number;
  };
  const bindings = (policy.bindings ?? [])
    .map((b) => {
      if (b.role !== role || b.condition) return b;
      const members = (b.members ?? []).filter((m) => m !== member);
      return { ...b, members };
    })
    .filter((b) => (b.members?.length ?? 0) > 0 || b.condition);
  const setRes = await fetch(`${crmBase}:setIamPolicy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ policy: { ...policy, bindings } }),
  });
  if (!setRes.ok) {
    throw new Error(await formatGcpError("Revoke IAM member", setRes));
  }
}

/** Enable a TTL policy on a field via PATCH with `ttlConfig: {}`. */
async function firestoreSetTtl(
  ctx: FirestoreContext,
  base: string,
  collectionGroup: string,
  fieldPath: string,
): Promise<{ name?: string }> {
  if (!collectionGroup || !fieldPath) {
    throw new Error("setTtl requires collectionGroup and fieldPath");
  }
  const tok = await ctx.token();
  const url = `${base}/collectionGroups/${encodeURIComponent(collectionGroup)}/fields/${encodeURIComponent(fieldPath)}?updateMask=ttlConfig`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttlConfig: {} }),
  });
  if (!res.ok) throw new Error(`Firestore set TTL ${res.status}: ${await res.text()}`);
  return (await res.json()) as { name?: string };
}

/** Remove a TTL policy — same PATCH with an empty ttlConfig wipe. */
async function firestoreUnsetTtl(
  ctx: FirestoreContext,
  fieldFullName: string,
): Promise<{ ok: true }> {
  if (!fieldFullName) throw new Error("unsetTtl requires the field resource name");
  const tok = await ctx.token();
  const url = `https://firestore.googleapis.com/v1/${fieldFullName}?updateMask=ttlConfig`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    // Omitting ttlConfig from the body while including it in the update
    // mask clears the TTL policy.
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Firestore unset TTL ${res.status}: ${await res.text()}`);
  return { ok: true };
}

async function firestoreExportDocuments(
  ctx: FirestoreContext,
  base: string,
  outputUriPrefix: string,
  collectionIdsCsv: string,
): Promise<{ name?: string }> {
  if (!outputUriPrefix) throw new Error("exportDocuments requires an outputUri");
  const ids = collectionIdsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tok = await ctx.token();
  const res = await fetch(`${base}:exportDocuments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      outputUriPrefix,
      ...(ids.length > 0 ? { collectionIds: ids } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Firestore export ${res.status}: ${await res.text()}`);
  return (await res.json()) as { name?: string };
}

async function firestoreImportDocuments(
  ctx: FirestoreContext,
  base: string,
  inputUriPrefix: string,
  collectionIdsCsv: string,
): Promise<{ name?: string }> {
  if (!inputUriPrefix) throw new Error("importDocuments requires an inputUri");
  const ids = collectionIdsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tok = await ctx.token();
  const res = await fetch(`${base}:importDocuments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputUriPrefix,
      ...(ids.length > 0 ? { collectionIds: ids } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Firestore import ${res.status}: ${await res.text()}`);
  return (await res.json()) as { name?: string };
}

async function firestoreListCollections(
  ctx: FirestoreContext,
  base: string,
): Promise<{ collections: string[] }> {
  const tok = await ctx.token();
  const collected: string[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const body: Record<string, unknown> = { pageSize: 100 };
    if (pageToken) body["pageToken"] = pageToken;
    const res = await fetch(`${base}/documents:listCollectionIds`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Firestore listCollectionIds ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { collectionIds?: string[]; nextPageToken?: string };
    for (const id of data.collectionIds ?? []) collected.push(id);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return { collections: collected.sort() };
}

async function firestoreFind(
  ctx: FirestoreContext,
  base: string,
  collection: string,
  skip: number,
  limit: number,
): Promise<{ documents: Array<Record<string, unknown>>; hasMore: boolean }> {
  if (!collection) return { documents: [], hasMore: false };
  const tok = await ctx.token();
  const want = skip + limit;
  const docs: Array<{ name?: string; fields?: Record<string, unknown> }> = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20 && docs.length < want + 1; i++) {
    const qs = new URLSearchParams({ pageSize: String(Math.min(300, want - docs.length + 1)) });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fetch(
      `${base}/documents/${encodeURIComponent(collection)}?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok) throw new Error(`Firestore list docs ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      documents?: Array<{ name?: string; fields?: Record<string, unknown> }>;
      nextPageToken?: string;
    };
    for (const d of data.documents ?? []) docs.push(d);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  const page = docs.slice(skip, skip + limit);
  return {
    documents: page.map((d) => firestoreDocToPlain(d)),
    hasMore: docs.length > skip + limit,
  };
}

async function firestoreCount(
  ctx: FirestoreContext,
  base: string,
  collection: string,
): Promise<{ count: number }> {
  if (!collection) return { count: 0 };
  const tok = await ctx.token();
  // Use the structured aggregation query (runAggregationQuery) for an
  // efficient COUNT without streaming every doc.
  const res = await fetch(`${base}/documents:runAggregationQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId: collection }] },
        aggregations: [{ alias: "c", count: {} }],
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore count ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Array<{
    result?: { aggregateFields?: { c?: { integerValue?: string } } };
  }>;
  const val = data?.[0]?.result?.aggregateFields?.c?.integerValue ?? "0";
  return { count: Number(val) };
}

async function firestoreGetDocument(
  ctx: FirestoreContext,
  base: string,
  docPath: string,
): Promise<Record<string, unknown>> {
  const tok = await ctx.token();
  const res = await fetch(`${base}/documents/${docPath}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`Firestore get doc ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { name?: string; fields?: Record<string, unknown> };
  return firestoreDocToPlain(data);
}

async function firestoreInsertDocument(
  ctx: FirestoreContext,
  base: string,
  collection: string,
  docJson: string,
): Promise<Record<string, unknown>> {
  if (!collection) throw new Error("insertDocument requires a collection");
  const parsed = JSON.parse(docJson) as Record<string, unknown>;
  const tok = await ctx.token();
  const res = await fetch(`${base}/documents/${encodeURIComponent(collection)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: plainToFirestoreFields(parsed) }),
  });
  if (!res.ok) throw new Error(`Firestore insert ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { name?: string; fields?: Record<string, unknown> };
  return firestoreDocToPlain(data);
}

async function firestoreUpdateDocument(
  ctx: FirestoreContext,
  base: string,
  docPath: string,
  docJson: string,
): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(docJson) as Record<string, unknown>;
  const tok = await ctx.token();
  // PATCH with no updateMask replaces the document's fields entirely.
  const res = await fetch(`${base}/documents/${docPath}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: plainToFirestoreFields(parsed) }),
  });
  if (!res.ok) throw new Error(`Firestore update ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { name?: string; fields?: Record<string, unknown> };
  return firestoreDocToPlain(data);
}

async function firestoreDeleteDocument(
  ctx: FirestoreContext,
  base: string,
  docPath: string,
): Promise<{ ok: true }> {
  const tok = await ctx.token();
  const res = await fetch(`${base}/documents/${docPath}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`Firestore delete ${res.status}: ${await res.text()}`);
  return { ok: true };
}

async function firestoreDeleteCollection(
  ctx: FirestoreContext,
  base: string,
  collection: string,
): Promise<{ deletedCount: number }> {
  let deletedCount = 0;
  for (let page = 0; page < 200; page++) {
    const { documents } = await firestoreFind(ctx, base, collection, page * 100, 100);
    if (documents.length === 0) break;
    await Promise.all(
      documents.map((doc) => {
        const fullName = typeof doc["_name"] === "string" ? (doc["_name"] as string) : "";
        const idx = fullName.indexOf("/documents/");
        const docPath = idx >= 0 ? fullName.slice(idx + "/documents/".length) : "";
        if (!docPath) return Promise.resolve();
        return firestoreDeleteDocument(ctx, base, docPath);
      }),
    );
    deletedCount += documents.length;
    if (documents.length < 100) break;
  }
  return { deletedCount };
}

async function firestoreCreateIndex(
  ctx: FirestoreContext,
  base: string,
  collectionGroup: string,
  fieldsJson: string,
  queryScope: string,
): Promise<{ name?: string }> {
  if (!collectionGroup) throw new Error("createIndex requires a collectionGroup");
  const parsed = JSON.parse(fieldsJson) as Array<{
    fieldPath: string;
    order?: string;
    arrayConfig?: string;
  }>;
  const tok = await ctx.token();
  const res = await fetch(
    `${base}/collectionGroups/${encodeURIComponent(collectionGroup)}/indexes`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryScope: queryScope || "COLLECTION",
        fields: parsed.map((f) => {
          const entry: Record<string, unknown> = { fieldPath: f.fieldPath };
          // The generic key-value-list picker submits one `order` value per
          // row. Firestore's API splits the space: ASCENDING/DESCENDING go
          // into `order`, and CONTAINS goes into `arrayConfig`. Reshape
          // here so the picker stays generic.
          if (f.arrayConfig === "CONTAINS" || f.order === "CONTAINS") {
            entry["arrayConfig"] = "CONTAINS";
          } else {
            entry["order"] = f.order ?? "ASCENDING";
          }
          return entry;
        }),
      }),
    },
  );
  if (!res.ok) throw new Error(`Firestore create index ${res.status}: ${await res.text()}`);
  return (await res.json()) as { name?: string };
}

async function firestoreDeleteIndex(
  ctx: FirestoreContext,
  indexFullName: string,
): Promise<{ ok: true }> {
  if (!indexFullName) throw new Error("deleteIndex requires the index name");
  const tok = await ctx.token();
  const res = await fetch(`https://firestore.googleapis.com/v1/${indexFullName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`Firestore delete index ${res.status}: ${await res.text()}`);
  return { ok: true };
}

async function firestoreCreateBackupSchedule(
  ctx: FirestoreContext,
  base: string,
  recurrence: string,
  retentionSeconds: number,
  weekDay: string,
): Promise<{ name?: string }> {
  const body: Record<string, unknown> = {
    retention: `${Math.max(1, Math.floor(retentionSeconds))}s`,
  };
  if (recurrence === "weekly") {
    body["weeklyRecurrence"] = { day: weekDay || "MONDAY" };
  } else {
    body["dailyRecurrence"] = {};
  }
  const tok = await ctx.token();
  const res = await fetch(`${base}/backupSchedules`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firestore create schedule ${res.status}: ${await res.text()}`);
  return (await res.json()) as { name?: string };
}

async function firestoreDeleteBackupSchedule(
  ctx: FirestoreContext,
  scheduleFullName: string,
): Promise<{ ok: true }> {
  if (!scheduleFullName) throw new Error("deleteBackupSchedule requires the schedule name");
  const tok = await ctx.token();
  const res = await fetch(`https://firestore.googleapis.com/v1/${scheduleFullName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`Firestore delete schedule ${res.status}: ${await res.text()}`);
  return { ok: true };
}

/**
 * Flatten a Firestore Document { name, fields: { k: {stringValue:...} } } into
 * a plain JS object: { _name: "...", k: "..." }. Keeps the full resource
 * name under `_name` so the UI can pass it to getDocument / deleteDocument.
 */
function firestoreDocToPlain(doc: {
  name?: string;
  fields?: Record<string, unknown>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (doc.name) out["_name"] = doc.name;
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    out[k] = firestoreValueToPlain(v);
  }
  return out;
}

function firestoreValueToPlain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const obj = v as Record<string, unknown>;
  if ("nullValue" in obj) return null;
  if ("booleanValue" in obj) return obj["booleanValue"];
  if ("integerValue" in obj) return Number(obj["integerValue"]);
  if ("doubleValue" in obj) return obj["doubleValue"];
  if ("stringValue" in obj) return obj["stringValue"];
  if ("timestampValue" in obj) return obj["timestampValue"];
  if ("bytesValue" in obj) return { $bytes: obj["bytesValue"] };
  if ("referenceValue" in obj) return { $ref: obj["referenceValue"] };
  if ("geoPointValue" in obj) return { $geo: obj["geoPointValue"] };
  if ("arrayValue" in obj) {
    const arr = (obj["arrayValue"] as { values?: unknown[] }).values ?? [];
    return arr.map((x) => firestoreValueToPlain(x));
  }
  if ("mapValue" in obj) {
    const m = (obj["mapValue"] as { fields?: Record<string, unknown> }).fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(m)) out[k] = firestoreValueToPlain(vv);
    return out;
  }
  return obj;
}

function plainToFirestoreFields(obj: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "_name") continue;
    fields[k] = plainToFirestoreValue(v);
  }
  return fields;
}

function plainToFirestoreValue(v: unknown): unknown {
  if (v === null) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((x) => plainToFirestoreValue(x)) } };
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(obj)) fields[k] = plainToFirestoreValue(vv);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
