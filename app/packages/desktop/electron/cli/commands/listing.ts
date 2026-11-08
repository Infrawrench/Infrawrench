// `infrawrench accounts | resources | resource`: the read commands
// over cloud orgs and the local workspace.
//
// `resolveScopedAccount` is the account resolution `--account` means
// everywhere (`resources`, `resource`, `export`, `apps`): an id, an exact
// name or a unique prefix, in the scope `--local`/`--org` names, or in every
// scope at once when neither does.
import { Effect, Option, Predicate } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  cloudAccounts,
  cloudResources,
  findAccount,
  listLocalAccounts,
  listLocalResources,
  loadLocalResourceOutputs,
  syncCloud,
  type AccountInfo,
  type ResourceRow,
} from "../context";
import { attempt, CloudApi } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { c, seriesColor } from "../output";

interface AccountScope {
  scope: string; // "local" or org display name
  orgId: string | null;
  accounts: AccountInfo[];
}

const localAccounts = Effect.promise(() => listLocalAccounts());

/**
 * Accounts in scope: --local → local only; --org → that org; neither →
 * everything, local first then each org (the CLI equivalent of the app's
 * org switcher list).
 */
const collectAccountScopes = Effect.gen(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  if (session.local) {
    return [{ scope: "local", orgId: null, accounts: yield* localAccounts }];
  }
  if (session.org) {
    const org = yield* api.resolveOrg(session.org);
    return [{ scope: org.displayName, orgId: org.id, accounts: yield* cloudAccounts(org.id) }];
  }
  const scopes: AccountScope[] = [{ scope: "local", orgId: null, accounts: yield* localAccounts }];
  if ((yield* api.authStatus).authenticated) {
    for (const org of yield* api.listOrgs) {
      scopes.push({
        scope: org.displayName,
        orgId: org.id,
        accounts: yield* cloudAccounts(org.id),
      });
    }
  }
  return scopes;
});

export const accounts = Command.make(
  "accounts",
  {},
  Effect.fn("accounts")(function* () {
    const session = yield* CliSession;
    const scopes = yield* collectAccountScopes;
    if (session.output === "json") return yield* Print.json(scopes);
    let first = true;
    for (const [idx, s] of scopes.entries()) {
      if (!first) yield* Print.line();
      first = false;
      yield* Print.line(seriesColor(idx)(c.bold(s.scope === "local" ? "Local" : s.scope)));
      yield* Print.table(s.accounts, [
        { header: "id", value: (a) => a.id },
        { header: "plugin", value: (a) => a.pluginId },
        { header: "name", value: (a) => c.bold(a.displayName) },
      ]);
    }
  }),
).pipe(Command.withDescription("List accounts (local + every org by default)"));

/**
 * The single account the resources/resource/export/apps commands operate
 * on: `wanted` (a resource id's account part, say) or else `--account`.
 */
export const resolveScopedAccount = Effect.fnUntraced(function* (wanted?: string) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const account = wanted ?? session.account;
  if (!account) {
    return yield* new CliFailure({
      message: "Pass --account <id|name> (see `infrawrench accounts`).",
    });
  }
  if (session.local) {
    return { orgId: null, account: yield* findAccount(yield* localAccounts, account) };
  }
  if (session.org) {
    const org = yield* api.resolveOrg(session.org);
    return { orgId: org.id, account: yield* findAccount(yield* cloudAccounts(org.id), account) };
  }
  // No scope flag: search local first, then every org; require uniqueness.
  const matches: Array<{ orgId: string | null; account: AccountInfo; scope: string }> = [];
  for (const s of yield* collectAccountScopes) {
    const found = yield* findAccount(s.accounts, account).pipe(Effect.option);
    if (Option.isSome(found))
      matches.push({ orgId: s.orgId, account: found.value, scope: s.scope });
  }
  const [only] = matches;
  if (only && matches.length === 1) return { orgId: only.orgId, account: only.account };
  if (matches.length === 0) {
    return yield* new CliFailure({ message: `No account matches "${account}".` });
  }
  return yield* new CliFailure({
    message: `"${account}" exists in several scopes (${matches
      .map((m) => m.scope)
      .join(", ")}). Disambiguate with --local or --org.`,
  });
});

/**
 * Re-sync a cloud account from the provider before listing it, so the listing
 * matches what exists *now*, the way the desktop account page does: the
 * poller's cache can lag or be missing types. A failed sync still lists the
 * cached rows. The sync blocks until the whole provider crawl finishes
 * (minutes on a big account) so say what the silence is on an interactive
 * terminal (stderr, so `--json | jq` stays clean).
 */
const syncBeforeListing = Effect.fnUntraced(function* (orgId: string, account: AccountInfo) {
  const showProgress = process.stderr.isTTY === true;
  if (showProgress) {
    yield* Effect.sync(() =>
      process.stderr.write(c.dim(`syncing ${account.displayName} from the provider… `)),
    );
  }
  const synced = yield* attempt(syncCloud(orgId, account.id));
  if (synced.ok) {
    if (showProgress) yield* Effect.sync(() => process.stderr.write(c.dim("done\n")));
    return;
  }
  if (showProgress) yield* Effect.sync(() => process.stderr.write("\n"));
  yield* Print.errLine(c.yellow(`sync failed, showing cached: ${synced.error}`));
});

const loadResources = Effect.fnUntraced(function* (
  orgId: string | null,
  account: AccountInfo,
  typeFilter: string | undefined,
) {
  if (orgId) {
    yield* syncBeforeListing(orgId, account);
    const rows = yield* cloudResources(orgId, account.id);
    const kept = typeFilter ? rows.filter((r) => r.resourceTypeId === typeFilter) : rows;
    return { rows: kept, errors: [] };
  }
  return yield* Effect.promise(() =>
    listLocalResources(account, typeFilter ? { typeId: typeFilter } : {}),
  );
});

export const resources = Command.make(
  "resources",
  {
    type: Flag.String("type").pipe(
      Flag.withMetavar("type-id"),
      Flag.withDescription("Only resources of this type"),
      Flag.optional,
    ),
  },
  Effect.fn("resources")(function* ({ type }) {
    const session = yield* CliSession;
    const { orgId, account } = yield* resolveScopedAccount();
    const { rows, errors } = yield* loadResources(orgId, account, Option.getOrUndefined(type));
    // Warnings go to stderr so `--json` stays a plain array for `jq`.
    yield* printListingErrors(errors);
    if (session.output === "json") return yield* Print.json(rows);
    yield* Print.line(`${c.bold(account.displayName)} ${c.dim(`(${account.pluginId})`)}`);
    const typeIndex = new Map<string, number>();
    for (const r of rows) {
      if (!typeIndex.has(r.resourceTypeId)) typeIndex.set(r.resourceTypeId, typeIndex.size);
    }
    yield* Print.table(rows, [
      {
        header: "type",
        value: (r) => seriesColor(typeIndex.get(r.resourceTypeId) ?? 0)(r.resourceTypeId),
      },
      { header: "name", value: (r) => c.bold(r.displayName) },
      { header: "external id", value: (r) => c.dim(r.externalId) },
    ]);
  }),
).pipe(Command.withDescription("List an account's resources (--account <id|name>)"));

/**
 * Resource types the provider refused. Reported on stderr so an empty table
 * is never mistaken for "this account has nothing".
 */
const printListingErrors = (
  errors: ReadonlyArray<{ typeId: string; message: string }>,
): Effect.Effect<void> =>
  Effect.forEach(errors, (e) => Print.errLine(c.yellow(`${e.typeId}: ${e.message}`)), {
    discard: true,
  });

export const resource = Command.make(
  "resource",
  {
    id: Argument.String("resource-id").pipe(
      Argument.withDescription("{accountId}:{typeId}:{externalId}, from `infrawrench resources`"),
      Argument.optional,
    ),
  },
  Effect.fn("resource")(function* ({ id }) {
    const session = yield* CliSession;
    const resourceId = Option.getOrElse(id, () => "");
    if (!resourceId) {
      return yield* new CliFailure({ message: "Usage: infrawrench resource <resource-id>" });
    }
    // Resource ids embed their account id: {accountId}:{typeId}:{externalId}.
    const { orgId, account } = yield* resolveScopedAccount(
      session.account || resourceId.split(":")[0] || undefined,
    );
    // Local ids carry their type, so a targeted list beats fanning out over
    // every resource type the plugin has.
    const typeId = orgId ? undefined : resourceId.split(":")[1];
    const rows: ResourceRow[] = orgId
      ? yield* cloudResources(orgId, account.id)
      : (yield* Effect.promise(() => listLocalResources(account, typeId ? { typeId } : {}))).rows;
    const found = rows.find((r) => r.id === resourceId);
    if (!found) {
      return yield* new CliFailure({
        message: `Resource ${resourceId} not found in ${account.displayName}.`,
      });
    }
    // Cloud rows arrive with their outputs; local ones resolve on demand.
    const row: ResourceRow = orgId
      ? found
      : yield* Effect.promise(() => loadLocalResourceOutputs(account, found));

    if (session.output === "json") return yield* Print.json(row);
    yield* Print.line(
      `${c.bold(row.displayName)} ${c.dim(`(${row.resourceTypeId} · ${account.displayName})`)}`,
    );
    yield* Print.line();
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
    yield* Print.keyValues(pairs);
  }),
).pipe(Command.withDescription("Show one resource's fields and outputs"));

function formatValue(v: unknown): string {
  if (v == null) return c.dim("—");
  if (Predicate.isString(v)) return v;
  return JSON.stringify(v);
}
