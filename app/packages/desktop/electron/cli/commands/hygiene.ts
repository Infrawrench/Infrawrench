// `infrawrench hygiene`: credentials the org is carrying that it probably
// should not be.
//
// The natural home for this is a scheduled `--json` run: unused keys and
// over-broad grants accumulate slowly and nobody opens a settings page to
// check. Piping this into whatever the org already reviews is the point.
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type { HygieneReport } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { days } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";

const Finding = Schema.Struct({
  severity: knownOr(["high", "medium", "low"]),
  title: Schema.String,
  detail: Schema.String,
});
type Finding = typeof Finding.Type;

const Report = wire<HygieneReport>()(
  Schema.Struct({
    windowDays: Schema.Finite,
    auditHistoryDays: Schema.NullOr(Schema.Finite),
    permissionFindingsWithheld: Schema.Boolean,
    findings: Schema.Array(Finding),
    counts: Schema.Struct({ high: Schema.Finite, medium: Schema.Finite, low: Schema.Finite }),
  }),
);

function severityCell(finding: Finding): string {
  // A severity a newer server added prints as it came, uncoloured.
  if (finding.severity instanceof Unrecognized) return safe(finding.severity.raw);
  switch (finding.severity) {
    case "high":
      return c.red("high");
    case "medium":
      return c.yellow("medium");
    case "low":
      return c.dim("low");
  }
}

export const hygiene = Command.make(
  "hygiene",
  {
    days: days.pipe(Flag.withDescription("Look back this many days (30, 90, 180 or 365)")),
  },
  Effect.fn("hygiene")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const query = Option.match(input.days, {
      onNone: () => "",
      onSome: (n) => `?windowDays=${n}`,
    });
    const path = `/credential-hygiene${query}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Report, path)(body);

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· credential hygiene over the last ${report.windowDays} days`)}`,
    );
    yield* Print.line();

    if (report.findings.length === 0) {
      yield* Print.line(c.green("Nothing to flag."));
    } else {
      const columns: Column<Finding>[] = [
        { header: "severity", value: (f) => severityCell(f) },
        { header: "what", value: (f) => safe(f.title) },
        { header: "why", value: (f) => c.dim(safe(f.detail)) },
      ];
      yield* Print.table(report.findings, columns);
      yield* Print.line();
      yield* Print.line(
        c.dim(
          `${report.counts.high} high · ${report.counts.medium} medium · ${report.counts.low} low`,
        ),
      );
    }

    yield* Print.line();
    // Stated on every run, not just when something is flagged: a reader who
    // takes "nothing to flag" as "nobody is over-permissioned" has misread the
    // evidence, and the caveat is what stops that.
    yield* Print.line(
      c.dim(
        "Unused means no write recorded in the audit log. Reads are not logged, so this says " +
          "nothing about what a person or key can see.",
      ),
    );
    if (report.permissionFindingsWithheld) {
      yield* Print.line(
        c.yellow(
          report.auditHistoryDays === null
            ? "No audit history yet. Unused-permission findings were withheld."
            : `Only ${report.auditHistoryDays} days of audit history. Unused-permission findings were withheld.`,
        ),
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Unused API keys, unreferenced SSH keys and unexercised write permissions",
  ),
);
