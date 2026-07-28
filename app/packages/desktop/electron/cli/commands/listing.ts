// `infrawrench orgs | accounts | resources | resource` — the read commands
// over cloud orgs and the local workspace.
import {
  CliError,
  listOrgs,
  resolveOrg,
  resolveAccount,
  listLocalAccounts,
  listCloudAccounts,
  listLocalResources,
  listCloudResources,
  loadLocalResourceOutputs,
  type AccountInfo,
  type CliContext,
  type ResourceRow,
} from "../context";
import { getAuthStatus } from "../../cloud-tokens";
import {
  c,
  printErr,
  printJson,
  println,
  printTable,
  printKeyValues,
  seriesColor,
} from "../output";

export async function cmdOrgs(ctx: CliContext): Promise<void> {
  const orgs = await listOrgs();
  if (ctx.flags.output === "json") {
    printJson(orgs);
    return;
  }
  printTable(orgs, [
    { header: "id", value: (o) => o.id },
    { header: "name", value: (o) => c.bold(o.displayName) },
    { header: "role", value: (o) => o.role },
  ]);
  println();
  println(c.dim("Plus the local workspace: use --local on any command."));
}

interface AccountScope {
  scope: string; // "local" or org display name
  orgId: string | null;
  accounts: AccountInfo[];
}

/**
 * Accounts in scope: --local → local only; --org → that org; neither →
 * everything, local first then each org (the CLI equivalent of the app's
 * org switcher list).
 */
async function collectAccountScopes(ctx: CliContext): Promise<AccountScope[]> {
  if (ctx.flags.local) {
    return [{ scope: "local", orgId: null, accounts: await listLocalAccounts() }];
  }
  if (ctx.flags.org) {
    const org = await resolveOrg(ctx);
    return [{ scope: org.displayName, orgId: org.id, accounts: await listCloudAccounts(org.id) }];
  }
  const scopes: AccountScope[] = [
    { scope: "local", orgId: null, accounts: await listLocalAccounts() },
  ];
  if ((await getAuthStatus()).authenticated) {
    for (const org of await listOrgs()) {
      scopes.push({
        scope: org.displayName,
        orgId: org.id,
        accounts: await listCloudAccounts(org.id),
      });
    }
  }
  return scopes;
}

export async function cmdAccounts(ctx: CliContext): Promise<void> {
  const scopes = await collectAccountScopes(ctx);
  if (ctx.flags.output === "json") {
    printJson(scopes);
    return;
  }
  let first = true;
  scopes.forEach((s, idx) => {
    if (!first) println();
    first = false;
    println(seriesColor(idx)(c.bold(s.scope === "local" ? "Local" : s.scope)));
    printTable(s.accounts, [
      { header: "id", value: (a) => a.id },
      { header: "plugin", value: (a) => a.pluginId },
      { header: "name", value: (a) => c.bold(a.displayName) },
    ]);
  });
}

/** Resolve the single account the resources/resource commands operate on. */
async function resolveScopedAccount(
  ctx: CliContext,
): Promise<{ orgId: string | null; account: AccountInfo }> {
  if (!ctx.flags.account) {
    throw new CliError("Pass --account <id|name> (see `infrawrench accounts`).");
  }
  if (ctx.flags.local) {
    return { orgId: null, account: resolveAccount(await listLocalAccounts(), ctx.flags.account) };
  }
  if (ctx.flags.org) {
    const org = await resolveOrg(ctx);
    return {
      orgId: org.id,
      account: resolveAccount(await listCloudAccounts(org.id), ctx.flags.account),
    };
  }
  // No scope flag: search local first, then every org; require uniqueness.
  const matches: Array<{ orgId: string | null; account: AccountInfo; scope: string }> = [];
  for (const s of await collectAccountScopes(ctx)) {
    try {
      matches.push({
        orgId: s.orgId,
        account: resolveAccount(s.accounts, ctx.flags.account),
        scope: s.scope,
      });
    } catch {
      /* no match in this scope */
    }
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CliError(`No account matches "${ctx.flags.account}".`);
  throw new CliError(
    `"${ctx.flags.account}" exists in several scopes (${matches
      .map((m) => m.scope)
      .join(", ")}) — disambiguate with --local or --org.`,
  );
}

export async function cmdResources(ctx: CliContext, typeFilter?: string): Promise<void> {
  const { orgId, account } = await resolveScopedAccount(ctx);
  let rows: ResourceRow[];
  let errors: Array<{ typeId: string; message: string }> = [];
  if (orgId) {
    rows = await listCloudResources(orgId, account.id);
    if (typeFilter) rows = rows.filter((r) => r.resourceTypeId === typeFilter);
  } else {
    const listing = await listLocalResources(account, typeFilter ? { typeId: typeFilter } : {});
    rows = listing.rows;
    errors = listing.errors;
  }
  // Warnings go to stderr so `--json` stays a plain array for `jq`.
  printListingErrors(errors);
  if (ctx.flags.output === "json") {
    printJson(rows);
    return;
  }
  println(`${c.bold(account.displayName)} ${c.dim(`(${account.pluginId})`)}`);
  const typeIndex = new Map<string, number>();
  for (const r of rows) {
    if (!typeIndex.has(r.resourceTypeId)) typeIndex.set(r.resourceTypeId, typeIndex.size);
  }
  printTable(rows, [
    {
      header: "type",
      value: (r) => seriesColor(typeIndex.get(r.resourceTypeId) ?? 0)(r.resourceTypeId),
    },
    { header: "name", value: (r) => c.bold(r.displayName) },
    { header: "external id", value: (r) => c.dim(r.externalId) },
  ]);
}

/**
 * Resource types the provider refused. Reported on stderr so an empty table
 * is never mistaken for "this account has nothing".
 */
function printListingErrors(errors: Array<{ typeId: string; message: string }>): void {
  for (const e of errors) {
    printErr(c.yellow(`${e.typeId}: ${e.message}`));
  }
}

export async function cmdResource(ctx: CliContext, resourceId: string): Promise<void> {
  if (!resourceId) throw new CliError("Usage: infrawrench resource <resource-id>");
  // Resource ids embed their account id: {accountId}:{typeId}:{externalId}.
  if (!ctx.flags.account) ctx.flags.account = resourceId.split(":")[0]!;
  const { orgId, account } = await resolveScopedAccount(ctx);
  // Local ids carry their type, so a targeted list beats fanning out over
  // every resource type the plugin has.
  const typeId = orgId ? undefined : resourceId.split(":")[1];
  const rows = orgId
    ? await listCloudResources(orgId, account.id)
    : (await listLocalResources(account, typeId ? { typeId } : {})).rows;
  let row = rows.find((r) => r.id === resourceId);
  if (!row) throw new CliError(`Resource ${resourceId} not found in ${account.displayName}.`);
  // Cloud rows arrive with their outputs; local ones resolve on demand.
  if (!orgId) row = await loadLocalResourceOutputs(account, row);

  if (ctx.flags.output === "json") {
    printJson(row);
    return;
  }
  println(
    `${c.bold(row.displayName)} ${c.dim(`(${row.resourceTypeId} · ${account.displayName})`)}`,
  );
  println();
  const pairs: Array<[string, string]> = [
    ["id", row.id],
    ["external id", row.externalId],
  ];
  if (row.parentResourceId) pairs.push(["parent", row.parentResourceId]);
  for (const [k, v] of Object.entries(row.fields)) {
    pairs.push([`field ${k}`, formatValue(v)]);
  }
  for (const [k, v] of Object.entries(row.outputs)) {
    pairs.push([`output ${k}`, formatValue(v)]);
  }
  printKeyValues(pairs);
}

function formatValue(v: unknown): string {
  if (v == null) return c.dim("—");
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
