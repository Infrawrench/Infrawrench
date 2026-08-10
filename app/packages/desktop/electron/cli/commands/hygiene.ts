import { orgFetch, resolveOrg, type CliContext } from "../context";
import type { HygieneFinding, HygieneReport } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";

function severityCell(finding: HygieneFinding): string {
  switch (finding.severity) {
    case "high":
      return c.red("high");
    case "medium":
      return c.yellow("medium");
    case "low":
      return c.dim("low");
  }
}

/**
 * `infrawrench hygiene` — credentials the org is carrying that it probably
 * should not be.
 *
 * The natural home for this is a scheduled `--json` run: unused keys and
 * over-broad grants accumulate slowly and nobody opens a settings page to
 * check. Piping this into whatever the org already reviews is the point.
 */
export async function cmdHygiene(
  ctx: CliContext,
  opts: { days?: number | null | undefined } = {},
): Promise<void> {
  const org = await resolveOrg(ctx);
  const query = opts.days ? `?windowDays=${opts.days}` : "";
  const report = await orgFetch<HygieneReport>(org.id, `/credential-hygiene${query}`);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...report });
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· credential hygiene over the last ${report.windowDays} days`)}`,
  );
  println();

  if (report.findings.length === 0) {
    println(c.green("Nothing to flag."));
  } else {
    const columns: Column<HygieneFinding>[] = [
      { header: "severity", value: (f) => severityCell(f) },
      { header: "what", value: (f) => f.title },
      { header: "why", value: (f) => c.dim(f.detail) },
    ];
    printTable(report.findings, columns);
    println();
    println(
      c.dim(
        `${report.counts.high} high · ${report.counts.medium} medium · ${report.counts.low} low`,
      ),
    );
  }

  println();
  // Stated on every run, not just when something is flagged: a reader who
  // takes "nothing to flag" as "nobody is over-permissioned" has misread the
  // evidence, and the caveat is what stops that.
  println(
    c.dim(
      "Unused means no write recorded in the audit log. Reads are not audit-logged, so nothing " +
        "here says anything about what a person or key can see — only about what they never did.",
    ),
  );
  if (report.permissionFindingsWithheld) {
    println(
      c.yellow(
        report.auditHistoryDays === null
          ? "No audit history yet — unused-permission findings were withheld."
          : `Only ${report.auditHistoryDays} days of audit history — unused-permission findings were withheld rather than guessed at.`,
      ),
    );
  }
}
