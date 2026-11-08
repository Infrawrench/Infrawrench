// `infrawrench expiring`; the cross-provider expiry radar: certificates,
// domains, tokens and keys approaching their deadlines, soonest first.
//
// Works in both modes, because the classification is declarative and runs over
// stored state rather than a live provider call:
//   - cloud (default): GET /expiring, the same endpoint the web + desktop
//     Expiring screens render.
//   - --local: electron/local-expiring.ts runs the shared computation over
//     this machine's SQLite workspace. No credentials, no network.
//
// The response shape comes from `@infrawrench/client-core` (the same
// definition every other surface uses) so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { listLocalExpiring } from "../../local-expiring";
import type { ExpiryListResponse, ExpirySeverity } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/expiring";

const Severity = Schema.Literals(["expired", "critical", "warning", "upcoming", "ok"]);

const Expiring = wire<ExpiryListResponse>()(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        displayName: Schema.String,
        resourceTypeName: Schema.String,
        accountName: Schema.String,
        label: Schema.String,
        dueAt: Schema.String,
        daysRemaining: Schema.Finite,
        severity: Severity,
      }),
    ),
    totalCount: Schema.Finite,
    counts: Schema.Struct({
      expired: Schema.Finite,
      critical: Schema.Finite,
      warning: Schema.Finite,
      upcoming: Schema.Finite,
      ok: Schema.Finite,
    }),
    leadDays: Schema.Finite,
  }),
);
type Expiring = typeof Expiring.Type;
type ExpiryItem = Expiring["items"][number];

/** Terminal tone per bucket: red = past due, yellow = close, dim = far out. */
const SEVERITY_COLOR: Record<ExpirySeverity, (s: string) => string> = {
  expired: c.red,
  critical: c.yellow,
  warning: c.yellow,
  upcoming: (s) => s,
  ok: c.dim,
};

/** "in 12d" / "due today" / "expired 3d ago", colored by urgency. */
function remaining(item: ExpiryItem): string {
  const text =
    item.daysRemaining < 0
      ? `expired ${-item.daysRemaining}d ago`
      : item.daysRemaining === 0
        ? "due today"
        : `in ${item.daysRemaining}d`;
  return SEVERITY_COLOR[item.severity](text);
}

/** The header's severity tally, e.g. "2 expired · 1 <7d · 4 <30d · 3 ≤60d". */
function countsSummary(response: Expiring): string {
  const { counts, leadDays } = response;
  const parts: string[] = [];
  if (counts.expired > 0) parts.push(c.red(`${counts.expired} expired`));
  if (counts.critical > 0) parts.push(c.yellow(`${counts.critical} <7d`));
  if (counts.warning > 0) parts.push(c.yellow(`${counts.warning} <30d`));
  if (counts.upcoming > 0) parts.push(`${counts.upcoming} ≤${leadDays}d`);
  if (counts.ok > 0) parts.push(c.dim(`${counts.ok} later`));
  return parts.join(c.dim(" · "));
}

/** The deadlines in scope: the local workspace, or the `--org` org's. */
const loadExpiring = Effect.fn("expiring.load")(function* () {
  const session = yield* CliSession;
  if (session.local) {
    const response = yield* Effect.promise(listLocalExpiring);
    return { label: "Local workspace", json: { ...response }, response };
  }
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  return {
    label: org.displayName,
    json: yield* spreadBody({ org: org.id }, body, PATH),
    response: yield* decodeBody(Expiring, PATH)(body),
  };
});

export const expiring = Command.make(
  "expiring",
  {},
  Effect.fn("expiring")(function* () {
    const session = yield* CliSession;
    const scope = yield* loadExpiring();
    const { response } = scope;

    if (session.output === "json") return yield* Print.json(scope.json);

    if (response.items.length === 0) {
      yield* Print.line(
        c.dim(
          "Nothing is on the clock. Deadlines appear when a plugin marks a synced field as expiry-bearing, such as a cert's end date or a domain's renewal.",
        ),
      );
      if (session.local) {
        yield* Print.line(
          c.dim("This scan covered the local workspace only; drop --local for your organization."),
        );
      }
      return;
    }

    yield* Print.line(
      `${c.bold(scope.label)} ${c.dim(
        `· ${response.totalCount} tracked deadline${response.totalCount === 1 ? "" : "s"}`,
      )}  ${countsSummary(response)}`,
    );
    yield* Print.line();

    // The contract serves the feed soonest first; copy-sort anyway so the table
    // never depends on a server's ordering.
    const rows = [...response.items].sort((a, b) => a.dueAt.localeCompare(b.dueAt));

    const columns: Column<ExpiryItem>[] = [
      { header: "resource", value: (r) => r.displayName },
      { header: "type", value: (r) => c.dim(r.resourceTypeName) },
      { header: "account", value: (r) => c.dim(r.accountName) },
      { header: "deadline", value: (r) => r.label },
      { header: "due", value: (r) => new Date(r.dueAt).toISOString().slice(0, 10) },
      { header: "remaining", value: (r) => remaining(r), align: "right" },
    ];
    yield* Print.table(rows, columns);

    yield* Print.line();
    yield* Print.line(
      c.dim(
        `Computed from already-synced fields. No provider was contacted. "≤${response.leadDays}d" follows the organization's expiry-alert lead time; age-based deadlines (key rotation budgets) count from the last rotation.`,
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Certificates, domains, tokens and keys approaching expiry, soonest first",
  ),
);
