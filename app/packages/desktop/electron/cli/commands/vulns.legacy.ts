// `infrawrench vulns`; known vulnerabilities (CVEs and other advisories) the
// connected providers' scanners report, joined to the synced resources that
// run the affected image, function or host right now, worst first.
//
// Cloud only. The findings are collected by the cloud poller from each
// provider's scanner and joined server-side (`GET /vulnerabilities`, the same
// endpoint the web + desktop Vulnerabilities screens render); this machine's
// workspace never collects them, so `--local` refuses rather than printing an
// empty list that reads as "no vulnerabilities".
//
// `vulns dismiss` / `vulns restore` accept and un-accept an advisory for one
// artifact (its `artifact.key`), or for every artifact (`*`).
//
// Each finding names the services its running resources belong to; the table
// prints them in a `service` column (when any finding has one) and
// `--service <id|slug|name>` narrows to one, resolved against `/services`;
// `--resource <id>` narrows to findings running on one resource.
//
// Types come from `@infrawrench/client-core` type-only; the shared filter and
// the "3 Pods and 1 Lambda Function" phrasing are reached through a dynamic
// `import()` (the CLI is CJS, client-core ESM), like `graph` and `ssh-fanout`.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { RangeFlags, VulnsFlags } from "../args";
import type {
  DismissedVulnerabilityFinding,
  ServiceListResponse,
  VulnerabilityDismissal,
  VulnerabilityFilter,
  VulnerabilityFindingRow,
  VulnerabilityListResponse,
  VulnerabilitySeverity,
  VulnerabilitySource,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";
import {
  formatAgo,
  formatKevFreshness,
  formatVulnAdvisory,
  formatVulnArtifact,
  formatVulnCvss,
  formatVulnPackage,
  formatVulnServices,
  matchService,
  matchVulnAccount,
  parseVulnSeverityFlag,
  VULN_SEVERITIES,
} from "../format";

/** Rows the text table shows without `--limit`; JSON is uncapped unless asked. */
const DEFAULT_TEXT_LIMIT = 50;

const SEVERITY_COLOR: Record<VulnerabilitySeverity, (s: string) => string> = {
  critical: c.red,
  high: c.yellow,
  medium: (s) => s,
  low: c.dim,
  unknown: c.dim,
};

const SEVERITY_WORD: Record<VulnerabilitySeverity, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unscored",
};

function colorSeverity(severity: VulnerabilitySeverity): string {
  // An unknown bucket from a newer server renders uncolored rather than crashing.
  return (SEVERITY_COLOR[severity] ?? ((s: string) => s))(SEVERITY_WORD[severity] ?? severity);
}

function refuseLocal(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "`vulns` is cloud-only: vulnerability findings are collected from each provider's scanner by the Infrawrench Cloud poller, not by this machine. Drop --local, or pass --org <id|name>.",
      2,
    );
  }
}

/** "2 critical (1 running) · 5 high (5 running)": the whole feed, every severity present. */
function countsSummary(response: VulnerabilityListResponse): string {
  const parts: string[] = [];
  for (const sev of VULN_SEVERITIES) {
    const total = response.counts[sev] ?? 0;
    if (total === 0) continue;
    const running = response.runningCounts[sev] ?? 0;
    parts.push(
      `${(SEVERITY_COLOR[sev] ?? ((s: string) => s))(`${total} ${SEVERITY_WORD[sev]}`)} ${c.dim(
        `(${running} running)`,
      )}`,
    );
  }
  return parts.join(c.dim(" · "));
}

/** Validate the flags into the shared filter; `--account` resolves against the feed's sources. */
function buildFilter(
  ctx: CliContext,
  flags: VulnsFlags,
  response: VulnerabilityListResponse,
): VulnerabilityFilter {
  const filter: VulnerabilityFilter = {
    running: flags.running,
    fixAvailable: flags.fixAvailable || undefined,
    kev: flags.kev || undefined,
    pluginId: flags.plugin,
    search: flags.search,
  };
  if (flags.severity !== undefined) {
    const { severities, invalid } = parseVulnSeverityFlag(flags.severity);
    if (invalid.length > 0 || severities.length === 0) {
      throw new CliError(
        `--severity takes a comma-separated list of ${VULN_SEVERITIES.join(", ")}${
          invalid.length > 0 ? ` (got "${invalid.join('", "')}")` : ""
        }.`,
        2,
      );
    }
    filter.severities = severities as VulnerabilitySeverity[];
  }
  if (ctx.flags.account) {
    const accountId = matchVulnAccount(response.sources, ctx.flags.account);
    if (!accountId) {
      const names = response.sources.map((s) => `  ${s.accountId}  ${safe(s.accountName)}`);
      throw new CliError(
        `No vulnerability-reporting account matches "${ctx.flags.account}".` +
          (names.length > 0 ? `\nAccounts with a scanner:\n${names.join("\n")}` : ""),
        2,
      );
    }
    filter.accountId = accountId;
  }
  return filter;
}

function isFiltered(filter: VulnerabilityFilter): boolean {
  return Object.values(filter).some((v) => v !== undefined);
}

/** Resolve `--service` against the org's services (not the feed's, so a clean service reads as clean). */
async function resolveServiceFilter(orgId: string, query: string): Promise<string> {
  const { services } = await orgFetch<ServiceListResponse>(orgId, "/services");
  const found = matchService(services, query);
  if (found.match) return found.match.id;
  if (found.candidates.length > 1) {
    throw new CliError(
      `"${query}" matches ${found.candidates.length} services: ${found.candidates
        .map((s) => safe(s.slug))
        .join(", ")}. Use the slug.`,
      2,
    );
  }
  throw new CliError(`No service matches "${query}". Run \`infrawrench services\` to list.`, 2);
}

/** `infrawrench vulns [list]`. */
export async function cmdVulns(
  ctx: CliContext,
  flags: VulnsFlags,
  range: RangeFlags,
): Promise<void> {
  refuseLocal(ctx);
  const org = await resolveOrg(ctx);
  const response = await orgFetch<VulnerabilityListResponse>(org.id, "/vulnerabilities");
  const filter = buildFilter(ctx, flags, response);
  if (flags.service !== undefined)
    filter.serviceId = await resolveServiceFilter(org.id, flags.service);
  if (range.resource) filter.resourceIds = [range.resource];
  const { filterVulnerabilityFindings, describeRunning } = await import("@infrawrench/client-core");

  const matched = filterVulnerabilityFindings(response.findings, filter);
  const dismissed = flags.includeDismissed
    ? filterVulnerabilityFindings(response.dismissed, filter)
    : [];

  if (ctx.flags.output === "json") {
    const limit = range.limit;
    // The response object, filtered: counts, runningCounts, dismissedCount and
    // sources still describe the whole feed so a script can tell a quiet
    // filter from a clean org. `matchedCount` is the filtered length.
    printJson({
      org: org.id,
      ...response,
      findings: limit ? matched.slice(0, limit) : matched,
      matchedCount: matched.length,
      dismissed: limit ? dismissed.slice(0, limit) : dismissed,
    });
    return;
  }

  const limit = range.limit ?? DEFAULT_TEXT_LIMIT;

  println(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${response.totalCount} open finding${response.totalCount === 1 ? "" : "s"}`,
    )}  ${countsSummary(response)}`,
  );
  println(formatKevFreshness(response.kevUpdatedAt));
  println();

  if (response.sources.length === 0) {
    println(
      c.dim(
        "No connected account reports vulnerabilities yet. Findings appear when a provider with a scanner (container registry scanning, a cloud security center, Dependabot, an artifact scanner) is connected and enabled.",
      ),
    );
    return;
  }

  if (matched.length === 0) {
    println(
      c.dim(
        isFiltered(filter)
          ? "No findings match those filters."
          : response.dismissedCount > 0
            ? "No open findings. Everything currently reported has been dismissed as an accepted risk."
            : "No open findings. The connected scanners report nothing.",
      ),
    );
  } else {
    if (isFiltered(filter)) {
      println(c.dim(`${matched.length} of ${response.totalCount} match the filters.`));
      println();
    }
    // The contract serves findings worst first (severity, running, KEV, CVSS);
    // the table keeps that order.
    const shown = matched.slice(0, limit);
    const columns: Column<VulnerabilityFindingRow>[] = [
      { header: "severity", value: (r) => colorSeverity(r.severity) },
      { header: "advisory", value: (r) => formatVulnAdvisory(r) },
      { header: "cvss", value: (r) => formatVulnCvss(r.cvssScore), align: "right" },
      { header: "package", value: (r) => formatVulnPackage(r) },
      { header: "artifact", value: (r) => c.dim(formatVulnArtifact(r.artifact)) },
      {
        header: "running",
        value: (r) => (r.running.length > 0 ? describeRunning(r.running) : c.dim("not running")),
      },
    ];
    // Only when something is in a service: a column of dashes says nothing.
    if (shown.some((r) => (r.services ?? []).length > 0)) {
      columns.push({ header: "service", value: (r) => formatVulnServices(r.services) });
    }
    printTable(shown, columns);
    if (matched.length > shown.length) {
      println();
      println(
        c.dim(
          `${matched.length - shown.length} more not shown. Raise --limit, narrow with --severity / --running / --kev / --service, or use --json.`,
        ),
      );
    }
  }

  if (flags.includeDismissed && dismissed.length > 0) printDismissed(dismissed.slice(0, limit));
  else if (response.dismissedCount > 0 && !flags.includeDismissed) {
    println();
    println(
      c.dim(
        `${response.dismissedCount} dismissed as accepted risk${
          response.dismissedCount === 1 ? "" : "s"
        }; list them with --include-dismissed.`,
      ),
    );
  }

  printSourceErrors(response.sources);

  println();
  println(
    c.dim(
      "Collected from each provider's scanner by the cloud poller and joined to synced resources. `infrawrench vulns sources` lists the scanners; dismiss with `vulns dismiss <advisoryId> <artifactKey|*>`.",
    ),
  );
}

/** Scanner accounts whose last collection failed: a silent gap reads as "clean". */
function printSourceErrors(sources: VulnerabilitySource[]): void {
  const failing = sources.filter((s) => s.error);
  if (failing.length === 0) return;
  println();
  println(
    c.yellow(
      `${failing.length} scanner${failing.length === 1 ? "" : "s"} failed on the last collection; their findings may be stale or missing:`,
    ),
  );
  for (const s of failing) {
    println(
      `  ${safe(s.accountName)} ${c.dim(`(${safe(s.pluginName)} · ${safe(s.scanner)})`)}: ${c.red(
        safe(s.error),
      )}`,
    );
    if (s.helpUrl) println(`    ${c.dim(`${safe(s.helpLabel) || "Help"}: ${safe(s.helpUrl)}`)}`);
  }
}

/**
 * The accepted risks, listed rather than hidden: a silenced finding nobody can
 * see is worse than a noisy one. Never colored by severity: these are
 * decisions, not alarms.
 */
function printDismissed(dismissed: DismissedVulnerabilityFinding[]): void {
  println();
  println(
    `${c.bold("Dismissed")} ${c.dim(
      `· ${dismissed.length} accepted risk${dismissed.length === 1 ? "" : "s"}`,
    )}`,
  );
  println();
  printTable(dismissed, [
    { header: "advisory", value: (r) => c.dim(safe(r.advisoryId)) },
    { header: "artifact", value: (r) => c.dim(formatVulnArtifact(r.artifact)) },
    {
      header: "scope",
      value: (r) => c.dim(r.dismissal.artifactKey === "*" ? "everywhere" : "this artifact"),
    },
    {
      header: "accepted",
      value: (r) =>
        c.dim(
          [r.dismissal.dismissedAt.slice(0, 10), r.dismissal.dismissedBy, r.dismissal.reason]
            .filter(Boolean)
            .map((s) => safe(s))
            .join(" · "),
        ),
    },
  ]);
  println();
  println(c.dim("Undo with `infrawrench vulns restore <advisoryId> <artifactKey|*>`."));
}

/** The advisory + artifact a dismiss/restore names. */
function requireTarget(verb: string, rest: string[]): { advisoryId: string; artifactKey: string } {
  const [advisoryId, artifactKey] = rest;
  if (!advisoryId?.trim() || !artifactKey?.trim()) {
    throw new CliError(
      `Usage: infrawrench vulns ${verb} <advisoryId> <artifactKey|"*">${
        verb === "dismiss" ? " [--reason <text>]" : ""
      }\n` +
        "The artifact key is each finding's `artifact.key` in `infrawrench vulns --json`; quote `*` " +
        "(the advisory everywhere in the organization) so the shell does not expand it.",
      2,
    );
  }
  return { advisoryId: advisoryId.trim(), artifactKey: artifactKey.trim() };
}

/** `infrawrench vulns dismiss <advisoryId> <artifactKey|*> [--reason ...]`. */
export async function cmdVulnsDismiss(ctx: CliContext, rest: string[]): Promise<void> {
  refuseLocal(ctx);
  const { advisoryId, artifactKey } = requireTarget("dismiss", rest);
  const org = await resolveOrg(ctx);
  const dismissal = await orgFetch<VulnerabilityDismissal>(org.id, "/vulnerabilities/dismissals", {
    method: "POST",
    body: JSON.stringify({ advisoryId, artifactKey, reason: ctx.flags.reason ?? null }),
  });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, dismissed: dismissal });
    return;
  }
  println(
    `${c.bold("Dismissed")} ${safe(dismissal.advisoryId)} ${c.dim(
      `· ${dismissal.artifactKey === "*" ? "everywhere" : safe(dismissal.artifactKey)}`,
    )}`,
  );
  println(
    c.dim(
      `Accepted for ${safe(org.displayName)}. It leaves the vulnerability list and the alerts until \`vulns restore\`.`,
    ),
  );
}

/** `infrawrench vulns restore <advisoryId> <artifactKey|*>`. */
export async function cmdVulnsRestore(ctx: CliContext, rest: string[]): Promise<void> {
  refuseLocal(ctx);
  const { advisoryId, artifactKey } = requireTarget("restore", rest);
  const org = await resolveOrg(ctx);
  const query = new URLSearchParams({ advisoryId, artifactKey });
  await orgFetch(org.id, `/vulnerabilities/dismissals?${query.toString()}`, { method: "DELETE" });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, restored: { advisoryId: advisoryId.toUpperCase(), artifactKey } });
    return;
  }
  println(
    `${c.bold("Restored")} ${safe(advisoryId.toUpperCase())} ${c.dim(
      `· ${artifactKey === "*" ? "everywhere" : safe(artifactKey)}`,
    )}`,
  );
  println(c.dim("Back on the vulnerability list and in the alerts."));
}

/** `infrawrench vulns sources`: which accounts report findings, and whether collection works. */
export async function cmdVulnsSources(ctx: CliContext): Promise<void> {
  refuseLocal(ctx);
  const org = await resolveOrg(ctx);
  const response = await orgFetch<VulnerabilityListResponse>(org.id, "/vulnerabilities");
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, sources: response.sources, kevUpdatedAt: response.kevUpdatedAt });
    return;
  }
  println(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${response.sources.length} scanner account${response.sources.length === 1 ? "" : "s"}`,
    )}`,
  );
  println(formatKevFreshness(response.kevUpdatedAt));
  println();
  if (response.sources.length === 0) {
    println(
      c.dim(
        "No connected account reports vulnerabilities yet. Connect a provider whose scanner Infrawrench reads (container registry scanning, a cloud security center, Dependabot, an artifact scanner).",
      ),
    );
    return;
  }
  printTable(response.sources, [
    { header: "account", value: (s) => safe(s.accountName) },
    { header: "provider", value: (s) => c.dim(safe(s.pluginName)) },
    { header: "scanner", value: (s) => safe(s.scanner) },
    { header: "findings", value: (s) => String(s.findingCount), align: "right" },
    {
      header: "collected",
      value: (s) => (s.lastCollectedAt ? c.dim(formatAgo(s.lastCollectedAt)) : c.dim("never")),
    },
    {
      header: "status",
      value: (s) =>
        s.error
          ? c.red("error")
          : s.lastCollectedAt
            ? s.partial
              ? c.yellow("ok (partial)")
              : c.green("ok")
            : c.dim("pending"),
    },
  ]);

  const detailed = response.sources.filter((s) => s.error || s.helpUrl || s.consoleUrl);
  if (detailed.length > 0) {
    println();
    for (const s of detailed) {
      println(`${c.bold(safe(s.accountName))} ${c.dim(`· ${safe(s.scanner)}`)}`);
      if (s.error) println(`  ${c.red(safe(s.error))}`);
      if (s.helpUrl) println(`  ${c.dim(`${safe(s.helpLabel) || "Help"}:`)} ${safe(s.helpUrl)}`);
      if (s.consoleUrl) println(`  ${c.dim("Console:")} ${safe(s.consoleUrl)}`);
    }
  }
  if (response.sources.some((s) => s.partial)) {
    println();
    println(c.dim("Partial: the provider's API returns a bounded subset of its findings."));
  }
}
