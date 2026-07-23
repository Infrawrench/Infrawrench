// Shared CLI state + data access. The CLI runs inside the packaged desktop
// binary (launched with --cli by the `infrawrench` shell shim), so it sees the
// same userData directory as the GUI: same SQLite database, same master key,
// same cloud session. Cloud data goes through the HTTP API; local data is read
// straight from the SQLite tables the GUI maintains.
import { getDb } from "../main-utils";
import { getAccessToken, forceRefreshAccessToken, fetchCloudOrgs } from "../cloud-tokens";
import { CLOUD_URL } from "../../env";

export type OutputMode = "json" | "text";

export interface CliFlags {
  output: OutputMode;
  color: boolean;
  org: string | null;
  local: boolean;
  account: string | null;
  help: boolean;
}

export interface CliContext {
  flags: CliFlags;
  positionals: string[];
  /** True when the GUI holds the single-instance lock — DB + tokens are read-only. */
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

export function notSignedInError(): CliError {
  return new CliError(
    "Not signed in to Infrawrench Cloud. Run `infrawrench login` (or sign in from the desktop app — the CLI shares its session).",
  );
}

/** Authenticated fetch against a non-org cloud path (e.g. /api/auth/orgs). */
export async function cloudGet<T>(path: string): Promise<T> {
  let token = await getAccessToken();
  if (!token) throw notSignedInError();
  let res = await fetch(`${CLOUD_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    const refreshed = await forceRefreshAccessToken();
    if (!refreshed) throw notSignedInError();
    token = refreshed;
    res = await fetch(`${CLOUD_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CliError(`Cloud request failed: ${res.status} ${path} ${text}`);
  }
  return (await res.json()) as T;
}

/** Authenticated fetch against an org-scoped cloud path. */
export async function orgFetch<T>(orgId: string, path: string, init: RequestInit = {}): Promise<T> {
  let token = await getAccessToken();
  if (!token) throw notSignedInError();
  const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}${path}`;
  const buildInit = (t: string): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${t}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let res = await fetch(url, buildInit(token));
  if (res.status === 401) {
    const refreshed = await forceRefreshAccessToken();
    if (!refreshed) throw notSignedInError();
    token = refreshed;
    res = await fetch(url, buildInit(token));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CliError(`Cloud request failed: ${res.status} ${path} ${text}`);
  }
  return (await res.json()) as T;
}

export interface OrgInfo {
  id: string;
  displayName: string;
  role: string;
}

export async function listOrgs(): Promise<OrgInfo[]> {
  const token = await getAccessToken();
  if (!token) throw notSignedInError();
  return fetchCloudOrgs();
}

/**
 * Resolve the --org flag (id, exact name, or unique name prefix) to an org.
 * With no flag: a single org wins by default; several orgs is an error that
 * lists the choices.
 */
export async function resolveOrg(ctx: CliContext): Promise<OrgInfo> {
  const orgs = await listOrgs();
  if (orgs.length === 0) {
    throw new CliError("You are not a member of any organization.");
  }
  const wanted = ctx.flags.org ?? process.env.INFRAWRENCH_ORG ?? null;
  if (!wanted) {
    if (orgs.length === 1) return orgs[0]!;
    throw new CliError(
      `Multiple organizations — pass --org <id|name>:\n${orgs
        .map((o) => `  ${o.id}  ${o.displayName}`)
        .join("\n")}`,
    );
  }
  const byId = orgs.find((o) => o.id === wanted);
  if (byId) return byId;
  const byName = orgs.filter((o) => o.displayName.toLowerCase().startsWith(wanted.toLowerCase()));
  if (byName.length === 1) return byName[0]!;
  throw new CliError(
    byName.length === 0
      ? `No organization matches "${wanted}".`
      : `"${wanted}" matches several organizations: ${byName.map((o) => o.displayName).join(", ")}.`,
  );
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
  return rows.map((r) => ({ id: r.id, pluginId: r.pluginId, displayName: r.displayName }));
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

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function listLocalResources(accountId?: string): Promise<ResourceRow[]> {
  const db = await getDb();
  const where = accountId ? " WHERE account_id = $1" : "";
  const rows = await db.select<
    Array<{
      id: string;
      plugin_id: string;
      resource_type_id: string;
      account_id: string;
      display_name: string;
      external_id: string;
      fields_json: string;
      outputs_json: string;
      parent_resource_id: string | null;
    }>
  >(
    `SELECT id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json, outputs_json, parent_resource_id FROM resources${where} ORDER BY resource_type_id, display_name`,
    accountId ? [accountId] : [],
  );
  return rows.map((r) => ({
    id: r.id,
    pluginId: r.plugin_id,
    resourceTypeId: r.resource_type_id,
    accountId: r.account_id,
    displayName: r.display_name,
    externalId: r.external_id,
    fields: parseJsonObject(r.fields_json),
    outputs: parseJsonObject(r.outputs_json),
    parentResourceId: r.parent_resource_id,
  }));
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
      fieldsJson: string | null;
      outputsJson: string | null;
      parentResourceId: string | null;
    }>
  >(orgId, `/accounts/${encodeURIComponent(accountId)}/resources`);
  return rows.map((r) => ({
    id: r.id,
    pluginId: r.pluginId,
    resourceTypeId: r.resourceTypeId,
    accountId: r.accountId,
    displayName: r.displayName,
    externalId: r.externalId,
    fields: parseJsonObject(r.fieldsJson),
    outputs: parseJsonObject(r.outputsJson),
    parentResourceId: r.parentResourceId,
  }));
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
