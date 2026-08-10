// `infrawrench expiring` — the cross-provider expiry radar: certificates,
// domains, tokens and keys approaching their deadlines, soonest first.
//
// Works in both modes, because the classification is declarative and runs over
// stored state rather than a live provider call:
//   - cloud (default) — GET /expiring, the same endpoint the web + desktop
//     Expiring screens render.
//   - --local — electron/local-expiring.ts runs the shared computation over
//     this machine's SQLite workspace. No credentials, no network.
//
// The response shape comes from `@infrawrench/client-core` — the same
// definition every other surface uses — so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import { listLocalExpiring } from "../../local-expiring";
import type {
  ExpiryItem,
  ExpiryListResponse,
  ExpirySeverity,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

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
function countsSummary(response: ExpiryListResponse): string {
  const { counts, leadDays } = response;
  const parts: string[] = [];
  if (counts.expired > 0) parts.push(c.red(`${counts.expired} expired`));
  if (counts.critical > 0) parts.push(c.yellow(`${counts.critical} <7d`));
  if (counts.warning > 0) parts.push(c.yellow(`${counts.warning} <30d`));
  if (counts.upcoming > 0) parts.push(`${counts.upcoming} ≤${leadDays}d`);
  if (counts.ok > 0) parts.push(c.dim(`${counts.ok} later`));
  return parts.join(c.dim(" · "));
}

export async function cmdExpiring(ctx: CliContext): Promise<void> {
  const scope = ctx.flags.local
    ? { label: "Local workspace", response: await listLocalExpiring(), json: {} }
    : await (async () => {
        const org = await resolveOrg(ctx);
        return {
          label: org.displayName,
          response: await orgFetch<ExpiryListResponse>(org.id, "/expiring"),
          json: { org: org.id },
        };
      })();
  const { response } = scope;

  if (ctx.flags.output === "json") {
    printJson({ ...scope.json, ...response });
    return;
  }

  if (response.items.length === 0) {
    println(
      c.dim(
        "Nothing is on the clock. Deadlines appear when a plugin marks a synced field as expiry-bearing — a cert's not-after date, a domain's renewal, a token's expiration, a key's age.",
      ),
    );
    if (ctx.flags.local) {
      println(
        c.dim("This scan covered the local workspace only; drop --local for your organization."),
      );
    }
    return;
  }

  println(
    `${c.bold(scope.label)} ${c.dim(
      `· ${response.totalCount} tracked deadline${response.totalCount === 1 ? "" : "s"}`,
    )}  ${countsSummary(response)}`,
  );
  println();

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
  printTable(rows, columns);

  println();
  println(
    c.dim(
      `Computed from already-synced fields — no provider was contacted. "≤${response.leadDays}d" follows the organization's expiry-alert lead time; age-based deadlines (key rotation budgets) count from the last rotation.`,
    ),
  );
}
