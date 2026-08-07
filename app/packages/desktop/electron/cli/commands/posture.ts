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
// `posture dismiss` / `posture restore` accept and un-accept a finding by
// (resource, rule). Cloud mode records the decision for the organization
// through the API; --local writes this machine's own table.
//
// The response shape comes from `@infrawrench/client-core` — the same
// definition every other surface uses — so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import {
  dismissLocalPostureFinding,
  listLocalPosture,
  restoreLocalPostureFinding,
} from "../../local-posture";
import type {
  DismissedPostureFinding,
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

/**
 * The finding a dismiss/restore names. `--resource` already exists as the
 * global "focus one resource" flag; the rule id is the second positional so
 * the pair reads as one thing: `posture dismiss <resourceId> <ruleId>`.
 */
function requireTarget(rest: string[]): { resourceId: string; ruleId: string } {
  const [resourceId, ruleId] = rest;
  if (!resourceId || !ruleId) {
    throw new CliError(
      "Usage: infrawrench posture dismiss|restore <resourceId> <ruleId> [--reason <text>]\n" +
        "Both ids are printed by `infrawrench posture --json`.",
      2,
    );
  }
  return { resourceId, ruleId };
}

/** `infrawrench posture dismiss <resourceId> <ruleId> [--reason ...]`. */
export async function cmdPostureDismiss(ctx: CliContext, rest: string[]): Promise<void> {
  const { resourceId, ruleId } = requireTarget(rest);
  const reason = ctx.flags.reason ?? null;

  if (ctx.flags.local) {
    // A CLI write while the GUI holds the lock is applied in memory and never
    // persisted (the DB is read-only), so refuse rather than silently lose it.
    if (ctx.guiRunning) {
      throw new CliError(
        "The Infrawrench desktop app is running — dismiss the finding from the app instead; the CLI shares its workspace.",
      );
    }
    await dismissLocalPostureFinding(resourceId, ruleId, reason);
    if (ctx.flags.output === "json") {
      printJson({ dismissed: { resourceId, ruleId, reason } });
      return;
    }
    println(`${c.bold("Dismissed")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
    println(c.dim("Local workspace only. It stays off the list until `posture restore`."));
    return;
  }

  const org = await resolveOrg(ctx);
  const dismissal = await orgFetch<{ resourceId: string; ruleId: string; reason: string | null }>(
    org.id,
    "/posture/dismissals",
    { method: "POST", body: JSON.stringify({ resourceId, ruleId, reason }) },
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, dismissed: dismissal });
    return;
  }
  println(`${c.bold("Dismissed")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
  println(
    c.dim(
      `Accepted for ${org.displayName}. It leaves the posture list and the daily alerts until \`posture restore\`.`,
    ),
  );
}

/** `infrawrench posture restore <resourceId> <ruleId>`. */
export async function cmdPostureRestore(ctx: CliContext, rest: string[]): Promise<void> {
  const { resourceId, ruleId } = requireTarget(rest);

  if (ctx.flags.local) {
    if (ctx.guiRunning) {
      throw new CliError(
        "The Infrawrench desktop app is running — restore the finding from the app instead; the CLI shares its workspace.",
      );
    }
    const restored = await restoreLocalPostureFinding(resourceId, ruleId);
    if (!restored) throw new CliError("That finding is not dismissed in the local workspace.");
    if (ctx.flags.output === "json") {
      printJson({ restored: { resourceId, ruleId } });
      return;
    }
    println(`${c.bold("Restored")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
    return;
  }

  const org = await resolveOrg(ctx);
  const query = new URLSearchParams({ resourceId, ruleId });
  await orgFetch(org.id, `/posture/dismissals?${query.toString()}`, { method: "DELETE" });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, restored: { resourceId, ruleId } });
    return;
  }
  println(`${c.bold("Restored")} ${resourceId} ${c.dim(`· ${ruleId}`)}`);
  println(c.dim("Back on the posture list and in the daily alerts."));
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
      response.dismissedCount > 0
        ? c.dim(
            "No open findings — everything currently flagged has been dismissed as an accepted risk.",
          )
        : c.dim(
            "No findings. Checks appear when a plugin declares posture rules over synced fields — a bucket's public-access setting, a firewall's source ranges, a disk's encryption flag.",
          ),
    );
    if (response.dismissedCount > 0) printDismissed(response.dismissed);
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

  if (response.dismissedCount > 0) printDismissed(response.dismissed);

  println();
  println(
    c.dim(
      "Computed from already-synced fields — no provider was contacted. Rules are declared by each plugin; critical & high findings feed the daily posture alerts.",
    ),
  );
}

/**
 * The accepted risks, listed rather than hidden — a silenced finding nobody
 * can see is worse than a noisy one. Never colored by severity: these are
 * decisions, not alarms.
 */
function printDismissed(dismissed: DismissedPostureFinding[]): void {
  println();
  println(
    `${c.bold("Dismissed")} ${c.dim(
      `· ${dismissed.length} accepted risk${dismissed.length === 1 ? "" : "s"}`,
    )}`,
  );
  println();
  printTable(dismissed, [
    { header: "resource", value: (r) => c.dim(r.displayName) },
    { header: "account", value: (r) => c.dim(r.accountName) },
    { header: "finding", value: (r) => c.dim(r.title) },
    {
      header: "accepted",
      value: (r) =>
        c.dim(
          [r.dismissal.dismissedAt.slice(0, 10), r.dismissal.dismissedBy, r.dismissal.reason]
            .filter(Boolean)
            .join(" · "),
        ),
    },
  ]);
  println();
  println(c.dim("Undo with `infrawrench posture restore <resourceId> <ruleId>`."));
}
