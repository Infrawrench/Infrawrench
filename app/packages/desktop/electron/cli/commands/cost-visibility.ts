import type { CostVisibilityScope, CostVisibilitySummary } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, type Column } from "../output";

const ME_PATH = "/team/me";
const SCOPES_PATH = "/cost-visibility";

const Visible = {
  costCentreIds: Schema.Array(Schema.String),
  accountIds: Schema.Array(Schema.String),
  savedFilterId: Schema.NullOr(Schema.String),
};

const Summary = wire<CostVisibilitySummary>()(
  Schema.Struct({
    restricted: Schema.Boolean,
    sources: Schema.Array(
      Schema.Struct({ kind: Schema.String, label: Schema.NullOr(Schema.String), ...Visible }),
    ),
  }),
);

/** `/team/me`, for the one field this reads: the caller's own cost scope. */
const Me = Schema.Struct({ costVisibility: Schema.optional(Summary) });
const RawMe = Schema.Struct({ costVisibility: Schema.optional(Schema.Unknown) });

const Scope = Schema.Struct({
  principalKind: Schema.String,
  principalLabel: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  ...Visible,
});
type Scope = typeof Scope.Type;

const Scopes = wire<{ scopes: CostVisibilityScope[] }>()(
  Schema.Struct({ scopes: Schema.Array(Scope) }),
);
const RawScopes = Schema.Struct({ scopes: Schema.Unknown });

const UNRESTRICTED = { restricted: false, sources: [] };

function kindLabel(kind: string): string {
  return kind === "api_key" ? "API key" : kind;
}

function describe(scope: {
  readonly costCentreIds: ReadonlyArray<string>;
  readonly accountIds: ReadonlyArray<string>;
  readonly savedFilterId: string | null;
}): string {
  const parts: string[] = [];
  if (scope.costCentreIds.length > 0) parts.push(`${scope.costCentreIds.length} cost centre(s)`);
  if (scope.accountIds.length > 0) parts.push(`${scope.accountIds.length} account(s)`);
  const base = parts.join(" or ");
  if (scope.savedFilterId) return base ? `${base}, filtered` : "saved filter only";
  return base || c.red("nothing (sees no costs)");
}

/**
 * `infrawrench cost-visibility`: who is limited to which costs.
 *
 * `cost-visibility` lists every scope in the org (needs `team:read`);
 * `cost-visibility me` says whether *your* cost figures are narrowed, which
 * is the first thing to check when the CLI's totals disagree with a
 * colleague's. Read-only: scopes are edited with pickers in Settings → Cost
 * Visibility, or with Terraform.
 */
const listScopes = Effect.fn("cost-visibility.list")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, SCOPES_PATH);

  if (session.output === "json") {
    const { scopes } = yield* decodeBody(RawScopes, SCOPES_PATH)(body);
    return yield* Print.json({ org: org.id, scopes });
  }
  const { scopes } = yield* decodeBody(Scopes, SCOPES_PATH)(body);
  if (scopes.length === 0) {
    return yield* Print.line(
      c.dim("No cost visibility scopes. Everyone with cost access sees all spend."),
    );
  }
  const columns: Column<Scope>[] = [
    { header: "kind", value: (s) => kindLabel(s.principalKind) },
    { header: "applies to", value: (s) => s.principalLabel ?? c.dim("deleted") },
    { header: "sees", value: (s) => describe(s) },
    { header: "updated", value: (s) => c.dim(s.updatedAt.slice(0, 10)) },
  ];
  yield* Print.line(`${c.bold(org.displayName)} ${c.dim(`· ${scopes.length} scope(s)`)}`);
  yield* Print.line();
  yield* Print.table(scopes, columns);
  yield* Print.line();
  yield* Print.line(c.dim("Edit scopes in Settings → Cost Visibility."));
});

const showMine = Effect.fn("cost-visibility.me")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, ME_PATH);

  if (session.output === "json") {
    const me = yield* decodeBody(RawMe, ME_PATH)(body);
    return yield* Print.json({ org: org.id, costVisibility: me.costVisibility ?? UNRESTRICTED });
  }
  const me = yield* decodeBody(Me, ME_PATH)(body);
  const summary = me.costVisibility ?? UNRESTRICTED;
  if (!summary.restricted) {
    return yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim("· you see all of the organization's costs")}`,
    );
  }
  yield* Print.line(
    `${c.bold(org.displayName)} ${c.yellow("· your cost figures are scoped")} ${c.dim(
      "(every layer below must match a cost row)",
    )}`,
  );
  yield* Print.line();
  yield* Print.table(summary.sources, [
    { header: "from", value: (s) => kindLabel(s.kind) },
    { header: "name", value: (s) => s.label ?? c.dim("unknown") },
    { header: "sees", value: (s) => describe(s) },
  ]);
});

export const costVisibility = Command.make("cost-visibility", {}, listScopes).pipe(
  Command.withDescription("Cost visibility scopes on roles, members and API keys (bare: list)"),
  Command.withSubcommands([
    Command.make("list", {}, listScopes).pipe(
      Command.withDescription("Every cost visibility scope in the organization"),
    ),
    Command.make("me", {}, showMine).pipe(
      Command.withDescription("Whether your own cost figures are scoped"),
    ),
  ]),
);
