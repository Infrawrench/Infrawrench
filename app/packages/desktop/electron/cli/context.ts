// Shared CLI state + data access. The CLI runs inside the packaged desktop
// binary (launched with --cli by the `infrawrench` shell shim), so it sees the
// same userData directory as the GUI: same SQLite database, same master key,
// same cloud session. Cloud data goes through the HTTP API; local data is read
// straight from the SQLite tables the GUI maintains.
import type { MetricSeries } from "@infrawrench/plugin-base";
import { getDb } from "../main-utils";
import { Effect, Predicate, Schema } from "effect";
import {
  fetchLocalMetricSeries,
  listAccountResourcesLive,
  resolveResourceOutputs,
} from "../plugin-runtime";
import { CloudApi } from "./effect/cloud-api";
import { CliFailure } from "./effect/errors";

/**
 * Error with a user-facing message and no stack trace on print, for Promise
 * code the CLI hands to something else to run (a plugin client, a workflow
 * runtime callback, a plugin-runtime helper): the runner prints it as one
 * line with its exit code. Effect code fails with the typed errors in
 * `effect/errors.ts` instead.
 */
export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
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

const CloudAccounts = Schema.Array(
  Schema.Struct({ id: Schema.String, pluginId: Schema.String, displayName: Schema.String }),
);

/** An org's connected accounts, by name: the order the local listing uses too. */
export const cloudAccounts = (orgId: string) =>
  CloudApi.use((api) => api.decode(CloudAccounts, orgId, "/accounts")).pipe(
    // The route doesn't order its rows, so without this the list (and the TUI
    // cursor's starting account) moves between invocations. Local accounts
    // come back `ORDER BY display_name`; match them.
    Effect.map((rows) =>
      rows
        .map((r): AccountInfo => ({ id: r.id, pluginId: r.pluginId, displayName: r.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    ),
  );

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
 * real JSON objects (`JsonObject` in web's http/schemas/common.ts): the name
 * is a leftover from the column, not a promise of a string. A string is still
 * accepted for anything that does send one.
 */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (Predicate.isObject(raw)) return { ...raw };
  if (!Predicate.isString(raw)) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return Predicate.isObject(parsed) ? { ...parsed } : {};
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

const SyncAnswer = Schema.Struct({
  synced: Schema.Finite,
  incompleteLists: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

/**
 * Ask the cloud to re-list every resource type of an account from the
 * provider right now. The poller keeps the cache warm on its own schedule,
 * but "show me this account" should mean what the provider says *now*: the
 * desktop account page syncs the same way. Answers the synced row count; a
 * list too long to read keeps its cached rows and still answers 200, which
 * is a `CliFailure` here with the server's sentence.
 */
export const syncCloud = (orgId: string, accountId: string) =>
  CloudApi.use((api) =>
    api.decode(SyncAnswer, orgId, `/accounts/${encodeURIComponent(accountId)}/sync`, {
      method: "POST",
    }),
  ).pipe(
    Effect.flatMap(({ synced, incompleteLists }) =>
      incompleteLists?.[0]
        ? Effect.fail(new CliFailure({ message: incompleteLists[0].message }))
        : Effect.succeed(synced),
    ),
  );

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

const CloudResources = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    pluginId: Schema.String,
    resourceTypeId: Schema.String,
    accountId: Schema.String,
    displayName: Schema.String,
    externalId: Schema.String,
    fieldsJson: Schema.Unknown,
    outputsJson: Schema.Unknown,
    parentResourceId: Schema.NullOr(Schema.String),
  }),
);

/** An org account's cached resources, by type then name like the local listing. */
export const cloudResources = (orgId: string, accountId: string) =>
  CloudApi.use((api) =>
    api.decode(CloudResources, orgId, `/accounts/${encodeURIComponent(accountId)}/resources`),
  ).pipe(
    Effect.map((rows) =>
      rows
        .map((r): ResourceRow => ({
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
          // The API returns rows in sync order; sort so a cloud listing reads
          // the same way as the local one.
          (a, b) =>
            a.resourceTypeId.localeCompare(b.resourceTypeId) ||
            a.displayName.localeCompare(b.displayName),
        ),
    ),
  );

/**
 * An account by id, exact name, or unique name prefix: what `--account` (and
 * any other account argument) means everywhere, or the sentence saying why not.
 */
function matchAccount(
  accounts: ReadonlyArray<AccountInfo>,
  wanted: string,
): { account: AccountInfo } | { refusal: string } {
  const byId = accounts.find((a) => a.id === wanted);
  if (byId) return { account: byId };
  const exact = accounts.filter((a) => a.displayName.toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return { account: exact[0]! };
  const prefix = accounts.filter((a) =>
    a.displayName.toLowerCase().startsWith(wanted.toLowerCase()),
  );
  if (prefix.length === 1) return { account: prefix[0]! };
  return {
    refusal:
      prefix.length === 0
        ? `No account matches "${wanted}".`
        : `"${wanted}" matches several accounts: ${prefix.map((a) => a.displayName).join(", ")}.`,
  };
}

/** {@link matchAccount}: the account, or a `CliFailure` saying why not. */
export const findAccount = (accounts: ReadonlyArray<AccountInfo>, wanted: string) =>
  Effect.suspend(() => {
    const found = matchAccount(accounts, wanted);
    return "account" in found
      ? Effect.succeed(found.account)
      : Effect.fail(new CliFailure({ message: found.refusal }));
  });
