// `infrawrench costs --anomalies feedback|suppressions|precision|sensitivity`:
// telling anomaly detection whether a finding was a real problem, and seeing
// what that feedback changed.
//
// Verbs under `costs` that follow `--anomalies`, like `posture dismiss`: the
// flag picks the question, the verb picks what to do about it. Bare
// `costs --anomalies` stays the listing (commands/costs.ts).
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`, so a server-side change breaks the CLI's build rather than its
// output, and the CLI still takes no runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CostAnomaly,
  CostAnomalyFeedbackInput,
  CostAnomalyFeedbackReason,
  CostAnomalyFeedbackResult,
  CostAnomalyPrecisionReport,
  CostAnomalyRecurrence,
  CostAnomalySensitivity,
  CostAnomalySuppression,
  CostAnomalyVerdict,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { positiveInt } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, spreadBody, wire } from "../effect/wire";
import { c, safe } from "../output";
import {
  ANOMALY_REASON_LABELS,
  ANOMALY_RECURRENCE_LABELS,
  ANOMALY_SCOPE_LABELS,
  matchIdPrefix,
  precisionChart,
  shortId,
  suppressionCoverLabel,
} from "../format";

/** The endpoint's own bound (`days` must be 1–90); checked before the request. */
export const MAX_ANOMALY_DAYS = 90;

export const DIMENSION_LABELS: Partial<Record<string, string>> = {
  provider: "provider",
  service: "service",
} satisfies Record<CostAnomaly["dimension"], string>;

/*
 * The feedback enums, restated as plain arrays: client-core is imported
 * type-only, and typing them against the wire unions fails this file's build
 * when a value is removed upstream.
 */
const FEEDBACK_REASONS: readonly CostAnomalyFeedbackReason[] = [
  "planned_launch",
  "migration",
  "seasonal",
  "pricing_change",
  "data_issue",
  "other",
];
const RECURRENCES: readonly CostAnomalyRecurrence[] = ["one_off", "weekly", "monthly", "seasonal"];
/** The API's own bounds (`COST_ANOMALY_FEEDBACK_LIMITS`), checked client-side. */
const NOTE_MAX_LENGTH = 500;
const PRECISION_MAX_MONTHS = 24;
const PRECISION_DEFAULT_MONTHS = 6;

/** One anomaly, as the listing and the feedback lines read it. */
export const AnomalyRow = wire<CostAnomaly>()(
  Schema.Struct({
    id: Schema.String,
    day: Schema.String,
    kind: Schema.String,
    dimension: Schema.String,
    dimensionKey: Schema.String,
    currency: Schema.String,
    actualCents: Schema.Finite,
    baselineCents: Schema.Finite,
    notifiedAt: Schema.NullOr(Schema.String),
    contributors: Schema.optional(
      Schema.Array(
        Schema.Struct({
          facet: Schema.String,
          key: Schema.String,
          label: Schema.String,
          deltaCents: Schema.Finite,
          share: Schema.NullOr(Schema.Finite),
          other: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
    acknowledgement: Schema.optional(Schema.NullOr(Schema.Struct({ explanation: Schema.String }))),
    feedback: Schema.optional(
      Schema.NullOr(
        Schema.Struct({ verdict: Schema.String, byName: Schema.NullOr(Schema.String) }),
      ),
    ),
    suppressionId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
type AnomalyRow = typeof AnomalyRow.Type;

const Suppression = wire<CostAnomalySuppression>()(
  Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
    scopeKey: Schema.String,
    tagKey: Schema.NullOr(Schema.String),
    scopeLabel: Schema.NullOr(Schema.String),
    recurrence: Schema.String,
    startsOn: Schema.String,
    expiresOn: Schema.String,
    reason: Schema.NullOr(Schema.String),
    active: Schema.Boolean,
    suppressedCount: Schema.Finite,
  }),
);
type Suppression = typeof Suppression.Type;

const FeedbackResult = wire<CostAnomalyFeedbackResult>()(
  Schema.Struct({ anomaly: AnomalyRow, suppression: Schema.NullOr(Suppression) }),
);

const PrecisionCounts = {
  detected: Schema.Finite,
  suppressed: Schema.Finite,
  expected: Schema.Finite,
  unexpected: Schema.Finite,
  precision: Schema.NullOr(Schema.Finite),
};
const Precision = wire<CostAnomalyPrecisionReport>()(
  Schema.Struct({
    months: Schema.Finite,
    periods: Schema.Array(Schema.Struct({ month: Schema.String, ...PrecisionCounts })),
    totals: Schema.Struct(PrecisionCounts),
    reasons: Schema.Array(Schema.Struct({ reason: Schema.String, count: Schema.Finite })),
  }),
);

const Sensitivity = wire<CostAnomalySensitivity>()(
  Schema.Struct({
    enabled: Schema.Boolean,
    windowDays: Schema.Finite,
    baseSigmas: Schema.Finite,
    adjustments: Schema.Array(
      Schema.Struct({
        dimension: Schema.String,
        dimensionKey: Schema.String,
        baseSigmas: Schema.Finite,
        sigmas: Schema.Finite,
        expectedCount: Schema.Finite,
        unexpectedCount: Schema.Finite,
        explanation: Schema.String,
      }),
    ),
  }),
);

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Anomaly feedback lives on Infrawrench Cloud with the anomalies it describes; there is no local cost history.",
    });
  }
});

const usage = (message: string) => new CliUsageError({ message });

const label = (labels: Partial<Record<string, string>>, value: string) =>
  safe(labels[value] ?? value);

const FEEDBACK_USAGE =
  "Usage: infrawrench costs --anomalies feedback <anomalyId> --expected|--unexpected [--reason <r>] [--note <text>] [--explain] [--recurrence <r> [--expires YYYY-MM-DD]]\n" +
  "       infrawrench costs --anomalies feedback <anomalyId> --clear\n" +
  "The id (or its first characters) is the first column of `infrawrench costs --anomalies`.";

/** True for a real calendar day in YYYY-MM-DD form (2026-02-30 is not one). */
export function isIsoDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** The feedback flags, as parsed. */
export interface FeedbackFlags {
  readonly expected: boolean;
  readonly unexpected: boolean;
  readonly clear: boolean;
  readonly reason: Option.Option<string>;
  readonly note: Option.Option<string>;
  readonly recurrence: Option.Option<string>;
  readonly expires: Option.Option<string>;
  readonly explain: boolean;
}

/**
 * The feedback flags → the request: `{ clear: true }` for `--clear` (a
 * DELETE), otherwise the POST body. Every combination the server would refuse,
 * or silently ignore, is an exit-2 error here instead: a suppression on an
 * `unexpected` verdict, `--explain` with no note to publish, an expiry with no
 * recurrence to expire.
 */
export const feedbackRequest = (
  flags: FeedbackFlags,
): Effect.Effect<
  { clear: true } | { clear: false; input: CostAnomalyFeedbackInput },
  CliUsageError
> => {
  const fail = (message: string) => Effect.fail(usage(message));
  if (flags.clear) {
    if (
      flags.expected ||
      flags.unexpected ||
      Option.isSome(flags.note) ||
      Option.isSome(flags.recurrence) ||
      Option.isSome(flags.expires) ||
      flags.explain ||
      Option.isSome(flags.reason)
    ) {
      return fail("--clear withdraws the verdict; it takes no other feedback flags.");
    }
    return Effect.succeed({ clear: true });
  }
  if (flags.expected === flags.unexpected) {
    return fail(
      flags.expected
        ? "--expected and --unexpected are mutually exclusive."
        : "Say what the spike was: --expected (planned or known) or --unexpected (a real problem). --clear withdraws a verdict.",
    );
  }
  const verdict: CostAnomalyVerdict = flags.expected ? "expected" : "unexpected";
  const input: CostAnomalyFeedbackInput = { verdict };

  if (Option.isSome(flags.reason)) {
    const wanted = flags.reason.value;
    const reason = FEEDBACK_REASONS.find((r) => r === wanted);
    if (!reason) {
      return fail(`--reason must be one of ${FEEDBACK_REASONS.join(", ")} (got "${wanted}").`);
    }
    input.reason = reason;
  }

  const note = Option.getOrUndefined(flags.note)?.trim() || undefined;
  if (note && note.length > NOTE_MAX_LENGTH) {
    return fail(`--note can be at most ${NOTE_MAX_LENGTH} characters, got ${note.length}.`);
  }
  if (flags.explain && !note) {
    return fail("--explain publishes the note as the anomaly's explanation; add --note <text>.");
  }
  if (note) input.note = note;
  if (flags.explain) input.explain = true;

  if (Option.isSome(flags.recurrence)) {
    const wanted = flags.recurrence.value;
    const recurrence = RECURRENCES.find((r) => r === wanted);
    if (!recurrence) {
      return fail(`--recurrence must be one of ${RECURRENCES.join(", ")} (got "${wanted}").`);
    }
    if (verdict !== "expected") {
      return fail(
        "--recurrence suppresses future alerts for this pattern, which only makes sense for an --expected spike.",
      );
    }
    input.suppress = { recurrence };
  }
  if (Option.isSome(flags.expires)) {
    if (!input.suppress) {
      return fail(
        "--expires sets when a suppression ends; add --recurrence one_off|weekly|monthly|seasonal.",
      );
    }
    if (!isIsoDay(flags.expires.value)) {
      return fail(`--expires must be a YYYY-MM-DD date, got "${flags.expires.value}".`);
    }
    input.suppress.expiresOn = flags.expires.value;
  }
  return Effect.succeed({ clear: false, input });
};

/**
 * `<anomalyId>` → the full id, accepting the short id the listing prints. Ids
 * are resolved against the widest window the listing endpoint serves; an id
 * it cannot see is sent as typed, so an older finding still works by full id
 * and the server says 404 if it does not exist.
 */
const resolveAnomalyId = Effect.fnUntraced(function* (orgId: string, query: string) {
  const api = yield* CloudApi;
  const path = `/costs/anomalies?days=${MAX_ANOMALY_DAYS}`;
  const { anomalies } = yield* api.decode(
    Schema.Struct({ anomalies: Schema.Array(AnomalyRow) }),
    orgId,
    path,
  );
  const found = matchIdPrefix(anomalies, query);
  if (found.match) return found.match.id;
  if (found.candidates.length > 1) {
    const list = found.candidates
      .map((a) => `  ${safe(a.id)}  ${safe(a.day)} ${safe(a.dimensionKey)}`)
      .join("\n");
    return yield* usage(`"${query}" matches ${found.candidates.length} anomalies:\n${list}`);
  }
  return query.trim();
});

/** "aws (provider) on 2026-10-01". */
function anomalyCaption(a: AnomalyRow): string {
  return `${c.bold(safe(a.dimensionKey))} ${c.dim(`(${label(DIMENSION_LABELS, a.dimension)})`)} on ${safe(a.day)}`;
}

/** "provider aws, weekly, 2026-10-01..2026-12-30". */
function suppressionSentence(s: Suppression): string {
  return `${label(ANOMALY_SCOPE_LABELS, s.scope)} ${c.bold(suppressionCoverLabel(s))}, ${label(ANOMALY_RECURRENCE_LABELS, s.recurrence)}, ${safe(s.startsOn)}..${safe(s.expiresOn)}`;
}

/**
 * `infrawrench costs --anomalies feedback <id> --expected|--unexpected|--clear`
 *
 * Gives a finding a verdict (sending it again replaces it), or withdraws one.
 * `--recurrence` on an expected verdict also creates a suppression so the same
 * pattern stops alerting; its scope, anchor and default expiry come from the
 * anomaly itself, as in the web and desktop feedback dialogs.
 */
const feedback = Command.make(
  "feedback",
  {
    id: Argument.String("anomalyId").pipe(
      Argument.withDescription("The id, or its first characters, from `costs --anomalies`"),
      Argument.optional,
    ),
    expected: Flag.Boolean("expected").pipe(
      Flag.withDescription("The spike was planned or known"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    unexpected: Flag.Boolean("unexpected").pipe(
      Flag.withDescription("The spike was a real problem"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    clear: Flag.Boolean("clear").pipe(
      Flag.withDescription("Withdraw the verdict (and the suppression it created)"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    reason: Flag.String("reason").pipe(
      Flag.withMetavar(FEEDBACK_REASONS.join("|")),
      Flag.withDescription("The reason category"),
      Flag.optional,
    ),
    note: Flag.String("note").pipe(
      Flag.withMetavar("text"),
      Flag.withDescription(`Context for the verdict (max ${NOTE_MAX_LENGTH} characters)`),
      Flag.optional,
    ),
    explain: Flag.Boolean("explain").pipe(
      Flag.withDescription("Also publish --note as the anomaly's explanation"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    recurrence: Flag.String("recurrence").pipe(
      Flag.withMetavar(RECURRENCES.join("|")),
      Flag.withDescription("--expected only: stop the pattern alerting"),
      Flag.optional,
    ),
    expires: Flag.String("expires").pipe(
      Flag.withMetavar("YYYY-MM-DD"),
      Flag.withDescription("The last day that suppression covers"),
      Flag.optional,
    ),
  },
  Effect.fn("costs.feedback")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (Option.isNone(input.id)) return yield* usage(FEEDBACK_USAGE);
    // Validate before any network: a typo'd enum should not cost a round trip.
    const request = yield* feedbackRequest(input);
    const org = yield* currentOrg;
    const id = yield* resolveAnomalyId(org.id, input.id.value);
    const path = `/costs/anomalies/${encodeURIComponent(id)}/feedback`;

    if (request.clear) {
      const body = yield* api.json(org.id, path, { method: "DELETE" });
      if (session.output === "json") return yield* Print.json({ org: org.id, anomaly: body });
      const anomaly = yield* decodeBody(AnomalyRow, path)(body);
      yield* Print.line(`${c.green("✓")} Withdrew the verdict on ${anomalyCaption(anomaly)}.`);
      return yield* Print.line(c.dim("Any suppression that verdict created was removed with it."));
    }

    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify(request.input),
    });
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }

    const { anomaly, suppression } = yield* decodeBody(FeedbackResult, path)(body);
    const { verdict, reason } = request.input;
    const tone = verdict === "unexpected" ? c.red : c.green;
    const reasonText = reason ? ` ${c.dim(`(${label(ANOMALY_REASON_LABELS, reason)})`)}` : "";
    yield* Print.line(
      `${c.green("✓")} Marked ${anomalyCaption(anomaly)} as ${tone(verdict)}${reasonText}.`,
    );
    if (request.input.explain) {
      yield* Print.line(
        c.dim(
          "The note is now the anomaly's explanation, drawn on every cost chart covering the day.",
        ),
      );
    }
    if (suppression) {
      yield* Print.line(
        `  ${c.dim("suppression")} ${suppressionSentence(suppression)}  ${c.dim(safe(shortId(suppression.id)))}`,
      );
      yield* Print.line(
        c.dim(
          "  Matching spikes are still recorded, marked suppressed, and do not alert. List them with: infrawrench costs --anomalies suppressions",
        ),
      );
    } else if (verdict === "expected") {
      yield* Print.line(
        c.dim(
          "Repeated expected verdicts on one provider or service nudge its threshold up a little; add --recurrence to stop a known pattern alerting at all.",
        ),
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Tell detection what a spike was: --expected | --unexpected | --clear (after --anomalies)",
  ),
);

const SUPPRESSIONS_PATH = "/costs/anomaly-suppressions";

const loadSuppressions = Effect.fnUntraced(function* (orgId: string) {
  const api = yield* CloudApi;
  const body = yield* api.decode(
    Schema.Struct({ suppressions: Schema.Unknown }),
    orgId,
    SUPPRESSIONS_PATH,
  );
  return {
    raw: body.suppressions,
    rows: yield* decodePaired(Schema.Array(Suppression), SUPPRESSIONS_PATH)(body.suppressions),
  };
});

/** `infrawrench costs --anomalies suppressions delete <id>`. */
const deleteSuppression = Command.make(
  "delete",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription(
        "The suppression, or its first characters, from `costs --anomalies suppressions`",
      ),
      Argument.optional,
    ),
  },
  Effect.fn("costs.suppressions.delete")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (Option.isNone(input.id)) {
      return yield* usage(
        "Usage: infrawrench costs --anomalies suppressions delete <id>\n" +
          "Ids are the first column of `infrawrench costs --anomalies suppressions`.",
      );
    }
    const query = input.id.value;
    const org = yield* currentOrg;
    const { rows } = yield* loadSuppressions(org.id);
    const found = matchIdPrefix(
      rows.map((r) => r.row),
      query,
    );
    if (!found.match) {
      if (found.candidates.length > 1) {
        const list = found.candidates
          .map((s) => `  ${safe(s.id)}  ${suppressionCoverLabel(s)}`)
          .join("\n");
        return yield* usage(`"${query}" matches ${found.candidates.length} suppressions:\n${list}`);
      }
      return yield* new CliFailure({ message: `No suppression matches "${query}".` });
    }
    const target = found.match;
    // 204 No Content: read as text, which has nothing to parse.
    yield* api.text(org.id, `${SUPPRESSIONS_PATH}/${encodeURIComponent(target.id)}`, {
      method: "DELETE",
    });
    if (session.output === "json") return yield* Print.json({ org: org.id, deleted: target.id });
    yield* Print.line(`${c.green("✓")} Deleted the suppression on ${suppressionSentence(target)}.`);
    yield* Print.line(c.dim("Matching spikes alert again from the next detection run."));
  }),
).pipe(Command.withDescription("Remove one suppression; matching spikes alert again"));

/** `infrawrench costs --anomalies suppressions`: what is being kept quiet. */
const suppressions = Command.make(
  "suppressions",
  {},
  Effect.fn("costs.suppressions")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const org = yield* currentOrg;
    const { raw, rows } = yield* loadSuppressions(org.id);
    if (session.output === "json") return yield* Print.json({ org: org.id, suppressions: raw });

    yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· anomaly suppressions")}`);
    yield* Print.line();
    if (rows.length === 0) {
      return yield* Print.line(
        c.dim(
          "No suppressions. Mark a spike expected with --recurrence to stop the same pattern alerting: infrawrench costs --anomalies feedback <id> --expected --recurrence weekly",
        ),
      );
    }

    yield* Print.table(
      rows.map((r) => r.row),
      [
        { header: "id", value: (s) => c.dim(safe(shortId(s.id))) },
        { header: "scope", value: (s) => label(ANOMALY_SCOPE_LABELS, s.scope) },
        { header: "covers", value: (s) => c.bold(suppressionCoverLabel(s)) },
        { header: "repeats", value: (s) => label(ANOMALY_RECURRENCE_LABELS, s.recurrence) },
        { header: "window", value: (s) => `${safe(s.startsOn)}..${safe(s.expiresOn)}` },
        { header: "status", value: (s) => (s.active ? c.green("active") : c.dim("expired")) },
        { header: "suppressed", value: (s) => String(s.suppressedCount), align: "right" },
        {
          header: "reason",
          value: (s) => (s.reason ? label(ANOMALY_REASON_LABELS, s.reason) : c.dim("-")),
        },
      ],
    );
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "On a covered day the scope's spend is set aside before the day is judged; a finding that only existed because of it is recorded as suppressed and does not alert. Remove one with: infrawrench costs --anomalies suppressions delete <id>",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "What is kept from alerting: scope, recurrence, window, hits, reason (after --anomalies)",
  ),
  Command.withSubcommands([deleteSuppression]),
);

/**
 * `infrawrench costs --anomalies precision [--months 6]`: per month, how many
 * findings were reviewed and what share of those were real problems.
 */
const precision = Command.make(
  "precision",
  {
    months: positiveInt("months").pipe(
      Flag.withMetavar("n"),
      Flag.withDescription(
        `Months to report (default ${PRECISION_DEFAULT_MONTHS}, max ${PRECISION_MAX_MONTHS})`,
      ),
      Flag.optional,
    ),
  },
  Effect.fn("costs.precision")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const span = Option.getOrElse(input.months, () => PRECISION_DEFAULT_MONTHS);
    if (span > PRECISION_MAX_MONTHS) {
      return yield* usage(`--months can be at most ${PRECISION_MAX_MONTHS}, asked for ${span}.`);
    }
    const org = yield* currentOrg;
    const path = `/costs/anomaly-precision?months=${span}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Precision, path)(body);

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· anomaly precision, last ${report.months} month${report.months === 1 ? "" : "s"}`)}`,
    );
    yield* Print.line();
    for (const row of precisionChart(report.periods)) yield* Print.line(row);
    yield* Print.line();
    const t = report.totals;
    const overall =
      t.precision === null ? c.dim("no verdicts yet") : c.bold(`${Math.round(t.precision * 100)}%`);
    yield* Print.line(
      `${c.dim("overall")} ${overall}  ${c.dim(`${t.expected + t.unexpected} of ${t.detected} reviewed · ${t.expected} expected · ${t.unexpected} unexpected · ${t.suppressed} suppressed`)}`,
    );
    if (report.reasons.length > 0) {
      const reasons = report.reasons
        .map((r) => `${label(ANOMALY_REASON_LABELS, r.reason)} ${c.dim(String(r.count))}`)
        .join(c.dim(" · "));
      yield* Print.line(`${c.dim("reasons")} ${reasons}`);
    }
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Precision is the share of reviewed findings marked unexpected: how often an alert was a real problem. Low precision means detection keeps flagging planned spend; mark those expected (with --recurrence for a known pattern) and it learns.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Per-month share of reviewed findings marked unexpected (after --anomalies)",
  ),
);

/**
 * `infrawrench costs --anomalies sensitivity`: which providers and services
 * feedback has made less sensitive, and why.
 */
const sensitivity = Command.make(
  "sensitivity",
  {},
  Effect.fn("costs.sensitivity")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const path = "/costs/anomaly-sensitivity";
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Sensitivity, path)(body);

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· anomaly sensitivity, base ${report.baseSigmas}σ, feedback from the last ${report.windowDays} days`)}`,
    );
    yield* Print.line();
    if (!report.enabled) {
      yield* Print.line(
        c.yellow("Feedback tuning is off for this org: every key is judged at the base threshold."),
      );
      yield* Print.line();
    }
    if (report.adjustments.length === 0) {
      return yield* Print.line(c.dim("No feedback in the window, so no threshold has moved."));
    }
    yield* Print.table(report.adjustments, [
      {
        header: "key",
        value: (a) =>
          `${c.bold(safe(a.dimensionKey))} ${c.dim(label(DIMENSION_LABELS, a.dimension))}`,
      },
      {
        header: "threshold",
        value: (a) => (a.sigmas > a.baseSigmas ? c.yellow(`${a.sigmas}σ`) : `${a.sigmas}σ`),
        align: "right",
      },
      { header: "expected", value: (a) => String(a.expectedCount), align: "right" },
      { header: "unexpected", value: (a) => String(a.unexpectedCount), align: "right" },
      { header: "why", value: (a) => c.dim(safe(a.explanation)) },
    ]);
  }),
).pipe(
  Command.withDescription(
    "Providers and services whose threshold feedback has raised, and why (after --anomalies)",
  ),
);

/** The verbs under `costs --anomalies`. */
export const anomalyCommands = [feedback, suppressions, precision, sensitivity] as const;
