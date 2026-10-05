// `infrawrench costs --anomalies feedback|suppressions|precision|sensitivity`:
// telling anomaly detection whether a finding was a real problem, and seeing
// what that feedback changed.
//
// Positional verbs after `--anomalies`, like `costs push` and `posture
// dismiss`: the flag picks the question, the verb picks what to do about it.
// Bare `costs --anomalies` stays the listing (commands/costs.ts).
//
// Wire shapes come type-only from `@infrawrench/client-core`, so a server-side
// change breaks the CLI's build rather than its output, and the CLI still takes
// no runtime dependency.
import { CliError, orgFetch, orgFetchText, resolveOrg, type CliContext } from "../context";
import type {
  CostAnomaly,
  CostAnomalyFeedbackResult,
  CostAnomalyPrecisionReport,
  CostAnomalySensitivity,
  CostAnomalySuppression,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { AnomalyFeedbackFlags } from "../args";
import { buildAnomalyFeedbackInput, resolvePrecisionMonths } from "../args";
import { c, printJson, println, printTable } from "../output";
import {
  ANOMALY_REASON_LABELS,
  ANOMALY_RECURRENCE_LABELS,
  ANOMALY_SCOPE_LABELS,
  matchIdPrefix,
  precisionChart,
  shortId,
  suppressionCoverLabel,
} from "../format";
import { DIMENSION_LABELS, MAX_ANOMALY_DAYS } from "./costs";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Anomaly feedback lives on Infrawrench Cloud with the anomalies it describes; there is no local cost history.",
    );
  }
}

const FEEDBACK_USAGE =
  "Usage: infrawrench costs --anomalies feedback <anomalyId> --expected|--unexpected [--reason <r>] [--note <text>] [--explain] [--recurrence <r> [--expires YYYY-MM-DD]]\n" +
  "       infrawrench costs --anomalies feedback <anomalyId> --clear\n" +
  "The id (or its first characters) is the first column of `infrawrench costs --anomalies`.";

/**
 * `<anomalyId>` → the full id, accepting the short id the listing prints. Ids
 * are resolved against the widest window the listing endpoint serves; an id
 * it cannot see is sent as typed, so an older finding still works by full id
 * and the server says 404 if it does not exist.
 */
async function resolveAnomalyId(orgId: string, query: string): Promise<string> {
  const { anomalies } = await orgFetch<{ anomalies: CostAnomaly[] }>(
    orgId,
    `/costs/anomalies?days=${MAX_ANOMALY_DAYS}`,
  );
  const found = matchIdPrefix(anomalies, query);
  if (found.match) return found.match.id;
  if (found.candidates.length > 1) {
    const list = found.candidates.map((a) => `  ${a.id}  ${a.day} ${a.dimensionKey}`).join("\n");
    throw new CliError(`"${query}" matches ${found.candidates.length} anomalies:\n${list}`, 2);
  }
  return query.trim();
}

/** "aws (provider) on 2026-10-01". */
function anomalyCaption(a: CostAnomaly): string {
  return `${c.bold(a.dimensionKey)} ${c.dim(`(${DIMENSION_LABELS[a.dimension]})`)} on ${a.day}`;
}

/** "provider aws, weekly, 2026-10-01..2026-12-30". */
function suppressionSentence(s: CostAnomalySuppression): string {
  const scope = ANOMALY_SCOPE_LABELS[s.scope] ?? s.scope;
  const recurrence = ANOMALY_RECURRENCE_LABELS[s.recurrence] ?? s.recurrence;
  return `${scope} ${c.bold(suppressionCoverLabel(s))}, ${recurrence}, ${s.startsOn}..${s.expiresOn}`;
}

/**
 * `infrawrench costs --anomalies feedback <id> --expected|--unexpected|--clear`
 *
 * Gives a finding a verdict (sending it again replaces it), or withdraws one.
 * `--recurrence` on an expected verdict also creates a suppression so the same
 * pattern stops alerting; its scope, anchor and default expiry come from the
 * anomaly itself, as in the web and desktop feedback dialogs.
 */
export async function cmdAnomalyFeedback(
  ctx: CliContext,
  anomalyId: string | undefined,
  flags: AnomalyFeedbackFlags,
): Promise<void> {
  requireCloud(ctx);
  if (!anomalyId) throw new CliError(FEEDBACK_USAGE, 2);
  // Validate before any network: a typo'd enum should not cost a round trip.
  const request = buildAnomalyFeedbackInput(flags, ctx.flags.reason);
  const org = await resolveOrg(ctx);
  const id = await resolveAnomalyId(org.id, anomalyId);
  const path = `/costs/anomalies/${encodeURIComponent(id)}/feedback`;

  if (request.clear) {
    const anomaly = await orgFetch<CostAnomaly>(org.id, path, { method: "DELETE" });
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, anomaly });
      return;
    }
    println(`${c.green("✓")} Withdrew the verdict on ${anomalyCaption(anomaly)}.`);
    println(c.dim("Any suppression that verdict created was removed with it."));
    return;
  }

  const result = await orgFetch<CostAnomalyFeedbackResult>(org.id, path, {
    method: "POST",
    body: JSON.stringify(request.input),
  });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...result });
    return;
  }

  const { anomaly, suppression } = result;
  const { verdict, reason } = request.input;
  const tone = verdict === "unexpected" ? c.red : c.green;
  const reasonText = reason ? ` ${c.dim(`(${ANOMALY_REASON_LABELS[reason] ?? reason})`)}` : "";
  println(`${c.green("✓")} Marked ${anomalyCaption(anomaly)} as ${tone(verdict)}${reasonText}.`);
  if (request.input.explain) {
    println(
      c.dim(
        "The note is now the anomaly's explanation, drawn on every cost chart covering the day.",
      ),
    );
  }
  if (suppression) {
    println(
      `  ${c.dim("suppression")} ${suppressionSentence(suppression)}  ${c.dim(shortId(suppression.id))}`,
    );
    println(
      c.dim(
        "  Matching spikes are still recorded, marked suppressed, and do not alert. List them with: infrawrench costs --anomalies suppressions",
      ),
    );
  } else if (verdict === "expected") {
    println(
      c.dim(
        "Repeated expected verdicts on one provider or service nudge its threshold up a little; add --recurrence to stop a known pattern alerting at all.",
      ),
    );
  }
}

async function listSuppressions(orgId: string): Promise<CostAnomalySuppression[]> {
  const { suppressions } = await orgFetch<{ suppressions: CostAnomalySuppression[] }>(
    orgId,
    "/costs/anomaly-suppressions",
  );
  return suppressions;
}

/** `infrawrench costs --anomalies suppressions`: what is being kept quiet. */
export async function cmdAnomalySuppressions(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const suppressions = await listSuppressions(org.id);
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, suppressions });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· anomaly suppressions")}`);
  println();
  if (suppressions.length === 0) {
    println(
      c.dim(
        "No suppressions. Mark a spike expected with --recurrence to stop the same pattern alerting: infrawrench costs --anomalies feedback <id> --expected --recurrence weekly",
      ),
    );
    return;
  }

  printTable(suppressions, [
    { header: "id", value: (s) => c.dim(shortId(s.id)) },
    { header: "scope", value: (s) => ANOMALY_SCOPE_LABELS[s.scope] ?? s.scope },
    { header: "covers", value: (s) => c.bold(suppressionCoverLabel(s)) },
    { header: "repeats", value: (s) => ANOMALY_RECURRENCE_LABELS[s.recurrence] ?? s.recurrence },
    { header: "window", value: (s) => `${s.startsOn}..${s.expiresOn}` },
    { header: "status", value: (s) => (s.active ? c.green("active") : c.dim("expired")) },
    { header: "suppressed", value: (s) => String(s.suppressedCount), align: "right" },
    {
      header: "reason",
      value: (s) => (s.reason ? (ANOMALY_REASON_LABELS[s.reason] ?? s.reason) : c.dim("-")),
    },
  ]);
  println();
  println(
    c.dim(
      "On a covered day the scope's spend is set aside before the day is judged; a finding that only existed because of it is recorded as suppressed and does not alert. Remove one with: infrawrench costs --anomalies suppressions delete <id>",
    ),
  );
}

/** `infrawrench costs --anomalies suppressions delete <id>`. */
export async function cmdDeleteAnomalySuppression(
  ctx: CliContext,
  query: string | undefined,
): Promise<void> {
  requireCloud(ctx);
  if (!query) {
    throw new CliError(
      "Usage: infrawrench costs --anomalies suppressions delete <id>\n" +
        "Ids are the first column of `infrawrench costs --anomalies suppressions`.",
      2,
    );
  }
  const org = await resolveOrg(ctx);
  const found = matchIdPrefix(await listSuppressions(org.id), query);
  if (!found.match) {
    if (found.candidates.length > 1) {
      const list = found.candidates.map((s) => `  ${s.id}  ${suppressionCoverLabel(s)}`).join("\n");
      throw new CliError(`"${query}" matches ${found.candidates.length} suppressions:\n${list}`, 2);
    }
    throw new CliError(`No suppression matches "${query}".`);
  }
  const target = found.match;
  // 204 No Content: orgFetch would fail parsing the empty body as JSON.
  await orgFetchText(org.id, `/costs/anomaly-suppressions/${encodeURIComponent(target.id)}`, {
    method: "DELETE",
  });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, deleted: target.id });
    return;
  }
  println(`${c.green("✓")} Deleted the suppression on ${suppressionSentence(target)}.`);
  println(c.dim("Matching spikes alert again from the next detection run."));
}

/**
 * `infrawrench costs --anomalies precision [--months 6]`: per month, how many
 * findings were reviewed and what share of those were real problems.
 */
export async function cmdAnomalyPrecision(
  ctx: CliContext,
  months: number | undefined,
): Promise<void> {
  requireCloud(ctx);
  const span = resolvePrecisionMonths(months);
  const org = await resolveOrg(ctx);
  const report = await orgFetch<CostAnomalyPrecisionReport>(
    org.id,
    `/costs/anomaly-precision?months=${span}`,
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...report });
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· anomaly precision, last ${report.months} month${report.months === 1 ? "" : "s"}`)}`,
  );
  println();
  for (const line of precisionChart(report.periods)) println(line);
  println();
  const t = report.totals;
  const overall =
    t.precision === null ? c.dim("no verdicts yet") : c.bold(`${Math.round(t.precision * 100)}%`);
  println(
    `${c.dim("overall")} ${overall}  ${c.dim(`${t.expected + t.unexpected} of ${t.detected} reviewed · ${t.expected} expected · ${t.unexpected} unexpected · ${t.suppressed} suppressed`)}`,
  );
  if (report.reasons.length > 0) {
    const reasons = report.reasons
      .map((r) => `${ANOMALY_REASON_LABELS[r.reason] ?? r.reason} ${c.dim(String(r.count))}`)
      .join(c.dim(" · "));
    println(`${c.dim("reasons")} ${reasons}`);
  }
  println();
  println(
    c.dim(
      "Precision is the share of reviewed findings marked unexpected: how often an alert was a real problem. Low precision means detection keeps flagging planned spend; mark those expected (with --recurrence for a known pattern) and it learns.",
    ),
  );
}

/**
 * `infrawrench costs --anomalies sensitivity`: which providers and services
 * feedback has made less sensitive, and why.
 */
export async function cmdAnomalySensitivity(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const report = await orgFetch<CostAnomalySensitivity>(org.id, "/costs/anomaly-sensitivity");
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...report });
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· anomaly sensitivity, base ${report.baseSigmas}σ, feedback from the last ${report.windowDays} days`)}`,
  );
  println();
  if (!report.enabled) {
    println(
      c.yellow("Feedback tuning is off for this org: every key is judged at the base threshold."),
    );
    println();
  }
  if (report.adjustments.length === 0) {
    println(c.dim("No feedback in the window, so no threshold has moved."));
    return;
  }
  printTable(report.adjustments, [
    {
      header: "key",
      value: (a) => `${c.bold(a.dimensionKey)} ${c.dim(DIMENSION_LABELS[a.dimension])}`,
    },
    {
      header: "threshold",
      value: (a) => (a.sigmas > a.baseSigmas ? c.yellow(`${a.sigmas}σ`) : `${a.sigmas}σ`),
      align: "right",
    },
    { header: "expected", value: (a) => String(a.expectedCount), align: "right" },
    { header: "unexpected", value: (a) => String(a.unexpectedCount), align: "right" },
    { header: "why", value: (a) => c.dim(a.explanation) },
  ]);
}
