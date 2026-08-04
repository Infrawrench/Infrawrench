// `infrawrench posture` — plugin-declared security checks over synced
// resources: public buckets, world-open ingress, unencrypted disks, stale
// credentials, missing backup/deletion protection, ranked by severity.
//
// Works in both modes, because the classification is declarative and runs
// over stored state rather than a live provider call:
//   - cloud (default) — GET /posture, the same endpoint the web + desktop
//     Posture screens render.
//   - --local — electron/local-posture.ts runs the shared computation over
//     this machine's SQLite workspace. No credentials, no network.
//
// The response shape comes from `@infrawrench/client-core` — the same
// definition every other surface uses — so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import { listLocalPosture } from "../../local-posture";
import type {
  PostureFinding,
  PostureListResponse,
  PostureSeverity,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

/** Terminal tone per bucket: red = drop everything, yellow = soon, dim = hygiene. */
const SEVERITY_COLOR: Record<PostureSeverity, (s: string) => string> = {
  critical: c.red,
  high: c.yellow,
  medium: (s) => s,
  low: c.dim,
};

/** The header's severity tally, e.g. "1 critical · 3 high · 2 medium". */
function countsSummary(response: PostureListResponse): string {
  const { counts } = response;
  const parts: string[] = [];
  if (counts.critical > 0) parts.push(c.red(`${counts.critical} critical`));
  if (counts.high > 0) parts.push(c.yellow(`${counts.high} high`));
  if (counts.medium > 0) parts.push(`${counts.medium} medium`);
  if (counts.low > 0) parts.push(c.dim(`${counts.low} low`));
  return parts.join(c.dim(" · "));
}

export async function cmdPosture(ctx: CliContext): Promise<void> {
  const scope = ctx.flags.local
    ? { label: "Local workspace", response: await listLocalPosture(), json: {} }
    : await (async () => {
        const org = await resolveOrg(ctx);
        return {
          label: org.displayName,
          response: await orgFetch<PostureListResponse>(org.id, "/posture"),
          json: { org: org.id },
        };
      })();
  const { response } = scope;

  if (ctx.flags.output === "json") {
    printJson({ ...scope.json, ...response });
    return;
  }

  if (response.findings.length === 0) {
    println(
      c.dim(
        "No findings. Checks appear when a plugin declares posture rules over synced fields — a bucket's public-access setting, a firewall's source ranges, a disk's encryption flag.",
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
      `· ${response.totalCount} finding${response.totalCount === 1 ? "" : "s"}`,
    )}  ${countsSummary(response)}`,
  );
  println();

  // The contract serves findings worst first; the table keeps that order.
  const columns: Column<PostureFinding>[] = [
    {
      header: "severity",
      // Unknown severity buckets from a newer server render uncolored
      // rather than crashing the whole listing.
      value: (r) => (SEVERITY_COLOR[r.severity] ?? ((s: string) => s))(r.severity),
    },
    { header: "resource", value: (r) => r.displayName },
    { header: "type", value: (r) => c.dim(r.resourceTypeName) },
    { header: "account", value: (r) => c.dim(r.accountName) },
    { header: "finding", value: (r) => r.title },
  ];
  printTable(response.findings, columns);

  println();
  println(
    c.dim(
      "Computed from already-synced fields — no provider was contacted. Rules are declared by each plugin; critical & high findings feed the daily posture alerts.",
    ),
  );
}
