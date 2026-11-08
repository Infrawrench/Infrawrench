// Shared CLI state + data access. The CLI runs inside the packaged desktop
// binary (launched with --cli by the `infrawrench` shell shim), so it sees the
// same userData directory as the GUI: same SQLite database, same master key,
// same cloud session. Cloud data goes through the HTTP API; local data is read
// straight from the SQLite tables the GUI maintains.
import type { MetricSeries } from "@infrawrench/plugin-base";
import { getDb } from "../main-utils";
import { Effect } from "effect";
import {
  fetchLocalMetricSeries,
  listAccountResourcesLive,
  resolveResourceOutputs,
} from "../plugin-runtime";
import { type CloudApi, type OrgInfo, runCloudApi } from "./effect/cloud-api";
import type { CloudError } from "./effect/errors";

type OutputMode = "json" | "text";

export interface CliFlags {
  output: OutputMode;
  color: boolean;
  org: string | null;
  local: boolean;
  account: string | null;
  /** `posture dismiss --reason`: why an accepted risk is acceptable. */
  reason: string | null;
  help: boolean;
}

export interface CliContext {
  flags: CliFlags;
  positionals: string[];
  /** True when the GUI holds the single-instance lock: DB + tokens are read-only. */
  guiRunning: boolean;
}

/** Error with a user-facing message and no stack trace on print. */
export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Run a {@link CloudApi} call for a command that has not moved to Effect yet:
 * a tagged failure becomes a `CliError` with the same sentence and exit code,
 * and a defect (a network error, a locked keychain) rejects as itself, which
 * `runCli`'s catch prints as it always has.
 */
function runCloud<A>(f: (api: CloudApi["Service"]) => Effect.Effect<A, CloudError>): Promise<A> {
  return Effect.runPromise(
    runCloudApi(f).pipe(Effect.mapError((e) => new CliError(e.message, e.exitCode))),
  );
}

/**
 * Authenticated fetch against an org-scoped cloud path.
 *
 * `T` is unchecked, as it always was here; a migrated command decodes the
 * body with `CloudApi.decode` and a schema instead.
 */
export async function orgFetch<T>(orgId: string, path: string, init: RequestInit = {}): Promise<T> {
  return (await runCloud((api) => api.json(orgId, path, init))) as T;
}

/**
 * Same as {@link orgFetch}, for an endpoint whose body is a document rather
 * than a JSON payload: today that is the asciicast a recorded SSH session
 * downloads as, which is newline-delimited JSON and would die on `JSON.parse`
 * at its header line.
 */
export function orgFetchText(orgId: string, path: string, init: RequestInit = {}): Promise<string> {
  return runCloud((api) => api.text(orgId, path, init));
}

/**
 * Same as {@link orgFetchText}, for a binary download: the server-rendered
 * PDF of a cost report or a dashboard. A body that turns out to be a web page
 * is the SPA catch-all answering for a route this server does not have, and
 * is reported as such rather than written to disk as a broken PDF.
 */
export async function orgFetchBytes(
  orgId: string,
  path: string,
  init: RequestInit = {},
): Promise<Uint8Array> {
  return (await orgFetchDownload(orgId, path, init)).bytes;
}

/**
 * {@link orgFetchBytes} plus the response's `Content-Disposition`, for a
 * download whose file name the server picks (the compliance evidence pack).
 */
export function orgFetchDownload(
  orgId: string,
  path: string,
  init: RequestInit = {},
): Promise<{ bytes: Uint8Array; contentDisposition: string | null }> {
  return runCloud((api) => api.download(orgId, path, init));
}

export type { OrgInfo };

export async function listOrgs(): Promise<OrgInfo[]> {
  return [...(await runCloud((api) => api.listOrgs))];
}

/**
 * Resolve the --org flag (id, exact name, or unique name prefix) to an org.
 * With no flag: a single org wins by default; several orgs is an error that
 * lists the choices.
 */
export function resolveOrg(ctx: CliContext): Promise<OrgInfo> {
  return runCloud((api) => api.resolveOrg(ctx.flags.org));
}

export interface AccountInfo {
  id: string;
  pluginId: string;
  displayName: string;
}

export async function listLocalAccounts(): Promise<AccountInfo[]> {
  const db = await getDb();
  const rows = await db.select<{ id: string; plugin_id: string; display_name: string }[]>(
    "SELECT id, plugin_id, display_name FROM accounts ORDER BY display_name",
  );
  return rows.map((r) => ({ id: r.id, pluginId: r.plugin_id, displayName: r.display_name }));
}

export async function listCloudAccounts(orgId: string): Promise<AccountInfo[]> {
  const rows = await orgFetch<
    Array<{ id: string; pluginId: string; displayName: string; createdAt: string }>
  >(orgId, "/accounts");
  // The route doesn't order its rows, so without this the list (and the TUI
  // cursor's starting account) moves between invocations. Local accounts come
  // back `ORDER BY display_name`; match them.
  return rows
    .map((r) => ({ id: r.id, pluginId: r.pluginId, displayName: r.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface ResourceRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string;
  fields: Record<string, unknown>;
  outputs: Record<string, unknown>;
  parentResourceId: string | null;
}

/**
 * `fieldsJson` / `outputsJson` are jsonb columns and the API serves them as
 * real JSON objects (`JsonObject` in api/openapi/paths/accounts.ts): the name
 * is a leftover from the column, not a promise of a string. A string is still
 * accepted for anything that does send one.
 */
function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") {
    return Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
  }
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface ResourceListing {
  rows: ResourceRow[];
  /** Resource types the provider refused. Reported, never silently dropped. */
  errors: Array<{ typeId: string; message: string }>;
}

/**
 * A local account's resources, read live from the provider.
 *
 * The local `resources` table is *not* the source of truth here: desktop only
 * writes rows for resources the app itself created or pinned, so a workspace
 * full of discovered droplets has an empty table. The GUI's sidebar and
 * account pages have always enumerated through the plugin: this does the
 * same, from the main process.
 */
export async function listLocalResources(
  account: AccountInfo,
  options: { typeId?: string } = {},
): Promise<ResourceListing> {
  const { resources, errors } = await listAccountResourcesLive(account, options);
  return {
    errors,
    rows: resources.map((r) => ({
      id: r.id,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      accountId: r.accountId,
      displayName: r.displayName,
      externalId: r.externalId ?? "",
      fields: r.fields,
      outputs: r.resolvedOutputs,
      parentResourceId: r.parentResourceId ?? null,
    })),
  };
}

/**
 * Fill in a local resource's outputs. `listResources` leaves them empty by
 * contract, so detail views resolve them separately.
 */
export async function loadLocalResourceOutputs(
  account: AccountInfo,
  row: ResourceRow,
): Promise<ResourceRow> {
  const outputs = await resolveResourceOutputs(account, row.resourceTypeId, row.id);
  return { ...row, outputs: { ...row.outputs, ...outputs } };
}

/**
 * Ask the cloud to re-list every resource type of an account from the
 * provider right now. The poller keeps the cache warm on its own schedule,
 * but "show me this account" should mean what the provider says *now*: the
 * desktop account page syncs the same way. Returns the synced row count.
 */
export async function syncCloudAccount(orgId: string, accountId: string): Promise<number> {
  const { synced, incompleteLists } = await orgFetch<{
    synced: number;
    incompleteLists?: Array<{ message: string }>;
  }>(orgId, `/accounts/${encodeURIComponent(accountId)}/sync`, { method: "POST" });
  // A list too long to read keeps its cached rows, and the sync still answers 200.
  if (incompleteLists?.[0]) throw new Error(incompleteLists[0].message);
  return synced;
}

/**
 * A local resource's metric series, fetched live from the provider the way
 * the GUI's Metrics tab does. Empty when the type has no metrics support.
 */
export async function fetchLocalMetrics(
  account: AccountInfo,
  resourceTypeId: string,
  resourceId: string,
  range?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  return fetchLocalMetricSeries(account, resourceTypeId, resourceId, range);
}

export async function listCloudResources(orgId: string, accountId: string): Promise<ResourceRow[]> {
  const rows = await orgFetch<
    Array<{
      id: string;
      pluginId: string;
      resourceTypeId: string;
      accountId: string;
      displayName: string;
      externalId: string;
      fieldsJson: unknown;
      outputsJson: unknown;
      parentResourceId: string | null;
    }>
  >(orgId, `/accounts/${encodeURIComponent(accountId)}/resources`);
  return rows
    .map((r) => ({
      id: r.id,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      accountId: r.accountId,
      displayName: r.displayName,
      externalId: r.externalId,
      fields: parseJsonObject(r.fieldsJson),
      outputs: parseJsonObject(r.outputsJson),
      parentResourceId: r.parentResourceId,
    }))
    .sort(
      // The API returns rows in sync order; sort so a cloud listing reads the
      // same way as the local one.
      (a, b) =>
        a.resourceTypeId.localeCompare(b.resourceTypeId) ||
        a.displayName.localeCompare(b.displayName),
    );
}

/** Resolve an account by id, exact name, or unique name prefix. */
export function resolveAccount(accounts: AccountInfo[], wanted: string): AccountInfo {
  const byId = accounts.find((a) => a.id === wanted);
  if (byId) return byId;
  const exact = accounts.filter((a) => a.displayName.toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return exact[0]!;
  const prefix = accounts.filter((a) =>
    a.displayName.toLowerCase().startsWith(wanted.toLowerCase()),
  );
  if (prefix.length === 1) return prefix[0]!;
  throw new CliError(
    prefix.length === 0
      ? `No account matches "${wanted}".`
      : `"${wanted}" matches several accounts: ${prefix.map((a) => a.displayName).join(", ")}.`,
  );
}
