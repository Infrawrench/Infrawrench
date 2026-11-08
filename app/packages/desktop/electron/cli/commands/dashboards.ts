// `infrawrench dashboards`: the org's dashboards, their scheduled deliveries,
// and the server-rendered PDF of one.
//
// A terminal cannot draw a dashboard's grid of cards, so this command does not
// try: it lists them, says who receives each one on a schedule, writes the PDF
// (`--format pdf`) that a browser download or a scheduled email would carry,
// and can deliver a dashboard to its schedules right now (`send`).
//
// Wire types come from `@infrawrench/client-core`, imported type-only like
// `reports`, so the CLI still ships zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  Dashboard,
  DashboardKpiResult,
  DashboardNotification,
  DashboardNotificationSendResult,
  DashboardWidget,
  DefaultDashboardResolution,
  KpiWidgetSource,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { attempt, bestEffort, CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import { destination, destinationOf, pdfFormat } from "../effect/file-flags";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import {
  decodePaired,
  knownOr,
  openUnion,
  type Paired,
  spreadBody,
  Unrecognized,
  wire,
} from "../effect/wire";
import { matchCostReport } from "../format";
import { c, safe } from "../output";
import { exportPdf, requirePdfForDestination } from "../pdf-export";
import { deliverySummary, describeSchedule, type ScheduleRow } from "./reports";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const DASHBOARDS_PATH = "/dashboards";

const DashboardRow = wire<Dashboard>()(
  Schema.Struct({ id: Schema.String, name: Schema.String, isDefault: Schema.Boolean }),
);
type DashboardRow = typeof DashboardRow.Type;
const Dashboards = Schema.Array(DashboardRow);

const Schedule = Schema.Struct({
  id: Schema.String,
  cadence: Schema.String,
  hour: Schema.Finite,
  sendDay: Schema.Finite,
  sendDayOfMonth: Schema.Finite,
  timezone: Schema.String,
  lastStatus: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  attachPdf: Schema.Boolean,
  slackChannelIds: Schema.Array(Schema.String),
  teamsWebhookIds: Schema.Array(Schema.String),
  emailRecipients: Schema.Array(Schema.String),
});
type Schedule = typeof Schedule.Type;
const Schedules = wire<DashboardNotification[]>()(Schema.Array(Schedule));
const Notifications = wire<DashboardNotification[]>()(
  Schema.Array(Schema.Struct({ ...Schedule.fields, dashboardId: Schema.String })),
);

const Landing = wire<DefaultDashboardResolution>()(
  Schema.Struct({
    dashboardId: Schema.String,
    dashboardName: Schema.String,
    source: Schema.String,
    roleDefault: Schema.NullOr(Schema.Struct({ roleName: Schema.String })),
    skipped: Schema.Array(Schema.String),
  }),
);
type Landing = typeof Landing.Type;

const SendResult = wire<DashboardNotificationSendResult>()(
  Schema.Struct({
    attempted: Schema.Finite,
    succeeded: Schema.Finite,
    pdfAttached: Schema.Boolean,
    slackFilesUploaded: Schema.Finite,
    slack: Schema.Struct({ attempted: Schema.Finite, succeeded: Schema.Finite }),
  }),
);

const SOURCE_KINDS = ["cost_report", "budget", "commitments", "realized_savings"] as const;

/**
 * A KPI card's source, whole: `kpiMeasureSummaryText` takes it. A kind or a
 * measure this build does not know is left to the card's title, or named raw.
 */
const KpiSource = openUnion(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("cost_report"),
      reportId: Schema.String,
      measure: knownOr(["cost", "usage", "count", "unit_cost", "business_metric"]),
      aggregation: knownOr(["sum", "daily_average"]),
      usageUnit: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal("budget"),
      budgetId: Schema.String,
      measure: knownOr(["actual", "forecast", "remaining", "percent_used"]),
    }),
    Schema.Struct({
      kind: Schema.Literal("commitments"),
      measure: knownOr(["coverage", "utilization", "savings"]),
    }),
    Schema.Struct({
      kind: Schema.Literal("realized_savings"),
      eventKind: Schema.optional(
        knownOr([
          "rightsizing",
          "orphan_deletion",
          "sleep_schedule",
          "commitment",
          "saas_seat",
          "manual",
        ]),
      ),
    }),
  ]),
  "kind",
  SOURCE_KINDS,
);
type KpiSource = typeof KpiSource.Type;

const Widget = wire<DashboardWidget>()(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    title: Schema.String,
    gridX: Schema.Finite,
    config: Schema.Unknown,
  }),
);
const FullDashboard = Schema.Struct({ widgets: Schema.optional(Schema.Array(Widget)) });
const KpiConfig = Schema.Struct({ source: KpiSource });

const KpiResult = wire<DashboardKpiResult>()(
  Schema.Struct({
    value: Schema.NullOr(Schema.Finite),
    unit: knownOr(["money", "money_per_unit", "percent", "count", "quantity"]),
    currency: Schema.optional(Schema.String),
    perUnit: Schema.optional(Schema.String),
    change: Schema.NullOr(Schema.Finite),
    changePercent: Schema.NullOr(Schema.Finite),
    upIsGood: Schema.Boolean,
    from: Schema.optional(Schema.String),
    to: Schema.optional(Schema.String),
  }),
);
type KpiResult = typeof KpiResult.Type;

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Dashboard PDFs and scheduled delivery live in Infrawrench Cloud. Drop --local to use them.",
    });
  }
});

/** Destination counts for one schedule: `"2 Slack, 1 email"`. */
function describeTargets(n: Schedule): string {
  const parts: string[] = [];
  if (n.slackChannelIds.length > 0) parts.push(`${n.slackChannelIds.length} Slack`);
  if (n.teamsWebhookIds.length > 0) parts.push(`${n.teamsWebhookIds.length} Teams`);
  if (n.emailRecipients.length > 0) {
    parts.push(`${n.emailRecipients.length} email${n.emailRecipients.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no destinations";
}

/** Why this is the caller's default: `"your choice"`, `"default for the Finance role"`. */
export function describeLanding(r: Pick<Landing, "source" | "roleDefault">): string {
  if (r.source === "user") return "your choice";
  if (r.source === "role") return `default for the ${safe(r.roleDefault?.roleName ?? "")} role`;
  return "organization default";
}

/** `infrawrench dashboards`: list the org's dashboards with their delivery. */
const listDashboards = Effect.fnUntraced(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const [dashboardsBody, notificationsBody, landingBody] = yield* Effect.all(
    [
      api.json(org.id, DASHBOARDS_PATH),
      // Org-wide in one call, like `reports`. Defensive: a server without
      // dashboard delivery costs the column, not the list.
      api.json(org.id, "/dashboard-notifications").pipe(bestEffort((): unknown => [])),
      // Which one you land on (yours, your role's, or the org's). Same
      // defensiveness: an older server just loses the marker.
      api.json(org.id, "/dashboards/default").pipe(bestEffort((): unknown => null)),
    ],
    { concurrency: "unbounded" },
  );

  if (session.output === "json") {
    return yield* Print.json({
      org: org.id,
      dashboards: dashboardsBody,
      notifications: notificationsBody,
      default: landingBody,
    });
  }
  const dashboards = yield* decodeBody(Dashboards, DASHBOARDS_PATH)(dashboardsBody);
  const notifications = yield* decodeBody(
    Notifications,
    "/dashboard-notifications",
  )(notificationsBody).pipe(bestEffort((): typeof Notifications.Type => []));
  const landing = yield* decodeBody(
    Schema.NullOr(Landing),
    "/dashboards/default",
  )(landingBody).pipe(bestEffort((): Landing | null => null));
  const schedulesByDashboard = new Map<string, ScheduleRow[]>();
  for (const n of notifications) {
    const list = schedulesByDashboard.get(n.dashboardId) ?? [];
    list.push(n);
    schedulesByDashboard.set(n.dashboardId, list);
  }

  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· dashboards")}`);
  yield* Print.line();

  if (dashboards.length === 0) {
    return yield* Print.line(c.dim("No dashboards yet. Create one in the web or desktop app."));
  }

  yield* Print.table(dashboards, [
    {
      header: "name",
      value: (d) => {
        const marks: string[] = [];
        if (landing?.dashboardId === d.id) marks.push("your default");
        if (d.isDefault) marks.push("org default");
        return marks.length > 0
          ? `${c.bold(safe(d.name))} ${c.dim(`(${marks.join(", ")})`)}`
          : c.bold(safe(d.name));
      },
    },
    {
      header: "delivery",
      value: (d) => deliverySummary(schedulesByDashboard.get(d.id) ?? []),
    },
    { header: "id", value: (d) => c.dim(d.id) },
  ]);

  if (landing) {
    yield* Print.line();
    yield* Print.line(
      `${c.dim("You land on")} ${c.bold(safe(landing.dashboardName))} ${c.dim(`· ${describeLanding(landing)}`)}`,
    );
    if (landing.skipped.includes("user")) {
      yield* Print.line(
        c.yellow("Your own default is no longer shared with you, so it was skipped."),
      );
    }
  }

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Save one as a PDF with `infrawrench dashboards <name|id> --format pdf`; `infrawrench dashboards send <name|id>` delivers it to its schedules now.",
    ),
  );
});

/** Resolve a name/id query to exactly one dashboard, beside the element the server sent. */
const resolveDashboard = Effect.fnUntraced(function* (orgId: string, query: string) {
  const api = yield* CloudApi;
  const dashboards = yield* decodePaired(
    Dashboards,
    DASHBOARDS_PATH,
  )(yield* api.json(orgId, DASHBOARDS_PATH));
  // Same matching rules as reports: id, case-insensitive exact name, then a
  // unique substring.
  const found = matchCostReport(
    dashboards.map((d) => ({ id: d.row.id, name: d.row.name, paired: d })),
    query,
  );
  if (found.match) return found.match.paired;
  if (found.candidates.length === 0) {
    return yield* new CliFailure({
      message: `No dashboard matches "${query}". Run \`infrawrench dashboards\` to see them.`,
    });
  }
  return yield* new CliFailure({
    message: `"${query}" matches ${found.candidates.length} dashboards: ${found.candidates
      .map((d) => d.name)
      .join(", ")}. Use the full name or the id.`,
  });
});

/** One KPI card answered: the figure, or why there is none. */
interface KpiReading {
  readonly widgetId: string;
  readonly title: string;
  readonly source: KpiSource | null;
  readonly config: unknown;
  readonly result: Paired<KpiResult> | null;
  readonly error: string | null;
}

/**
 * Answer every KPI card on a dashboard, in grid order. A card that fails
 * carries its error rather than failing the command, the PDF's rule.
 */
const readKpis = Effect.fnUntraced(function* (orgId: string, dashboardId: string) {
  const api = yield* CloudApi;
  const path = `/dashboards/${encodeURIComponent(dashboardId)}`;
  const full = yield* api.decode(FullDashboard, orgId, path);
  const kpis = (full.widgets ?? [])
    .filter((w) => w.kind === "kpi")
    .sort((a, b) => a.gridX - b.gridX);
  return yield* Effect.forEach(
    kpis,
    (w) =>
      Effect.gen(function* () {
        const source = yield* decodeBody(
          KpiConfig,
          path,
        )(w.config).pipe(
          Effect.map((k) => k.source),
          bestEffort((): KpiSource | null => null),
        );
        const answer = yield* attempt(
          api
            .json(orgId, "/dashboards/kpi", {
              method: "POST",
              body: JSON.stringify({ config: w.config }),
            })
            .pipe(
              Effect.flatMap((body) =>
                decodeBody(
                  KpiResult,
                  "/dashboards/kpi",
                )(body).pipe(Effect.map((row): Paired<KpiResult> => ({ row, raw: body }))),
              ),
            ),
        );
        return {
          widgetId: w.id,
          title: w.title,
          source,
          config: w.config,
          result: answer.ok ? answer.value : null,
          error: answer.ok ? null : answer.error,
        } satisfies KpiReading;
      }),
    { concurrency: "unbounded" },
  );
});

/** `kpiMeasureSummaryText`'s line, or the raw value this build cannot name. */
function summaryText(core: Core, source: KpiSource | null): string {
  if (!source) return "";
  const known = knownSource(source);
  return typeof known === "string" ? safe(known) : core.kpiMeasureSummaryText({ source: known });
}

/** The source as client-core types it, or the first value this build does not know. */
function knownSource(source: KpiSource): KpiWidgetSource | string {
  if (source instanceof Unrecognized) return source.raw;
  switch (source.kind) {
    case "cost_report": {
      const { measure, aggregation } = source;
      if (measure instanceof Unrecognized) return measure.raw;
      if (aggregation instanceof Unrecognized) return aggregation.raw;
      return { kind: source.kind, reportId: source.reportId, measure, aggregation };
    }
    case "budget":
      if (source.measure instanceof Unrecognized) return source.measure.raw;
      return { kind: source.kind, budgetId: source.budgetId, measure: source.measure };
    case "commitments":
      if (source.measure instanceof Unrecognized) return source.measure.raw;
      return { kind: source.kind, measure: source.measure };
    case "realized_savings": {
      const { eventKind } = source;
      if (eventKind instanceof Unrecognized) return `Realized savings: ${eventKind.raw}`;
      return { kind: source.kind, ...(eventKind ? { eventKind } : {}) };
    }
  }
}

/** The value cell: client-core's formatting, or the bare number for a unit this build does not know. */
function valueText(core: Core, k: KpiResult): string {
  if (k.unit instanceof Unrecognized) return k.value === null ? "-" : String(k.value);
  return core.formatDashboardKpiValue({ ...k, unit: k.unit });
}

const showDashboard = Effect.fnUntraced(function* (
  query: string,
  pdf: boolean,
  target: Option.Option<string>,
) {
  yield* requirePdfForDestination(pdf, target, "dashboards");
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const { row: dashboard, raw: rawDashboard } = yield* resolveDashboard(org.id, query.trim());
  const id = encodeURIComponent(dashboard.id);

  if (pdf) {
    return yield* exportPdf({
      orgId: org.id,
      path: `/dashboards/${id}/pdf`,
      target,
      subject: { kind: "dashboard", id: dashboard.id, name: dashboard.name },
    });
  }

  const schedulesPath = `/dashboards/${id}/notifications`;
  const [schedulesBody, kpis] = yield* Effect.all(
    [
      api.json(org.id, schedulesPath).pipe(bestEffort((): unknown => [])),
      // Defensive like the schedules: a server without KPI cards costs the
      // section, not the command.
      readKpis(org.id, dashboard.id).pipe(bestEffort((): ReadonlyArray<KpiReading> => [])),
    ],
    { concurrency: "unbounded" },
  );

  if (session.output === "json") {
    return yield* Print.json({
      org: org.id,
      dashboard: rawDashboard,
      notifications: schedulesBody,
      kpis: kpis.map((k) => ({
        widgetId: k.widgetId,
        title: k.title,
        config: k.config,
        result: k.result?.raw ?? null,
        error: k.error,
      })),
    });
  }
  const schedules = yield* decodeBody(
    Schedules,
    schedulesPath,
  )(schedulesBody).pipe(bestEffort((): typeof Schedules.Type => []));

  yield* Print.line(
    `${c.bold(safe(dashboard.name))}${dashboard.isDefault ? ` ${c.dim("(org default)")}` : ""} ${c.dim(`· ${dashboard.id}`)}`,
  );
  yield* Print.line();
  if (kpis.length > 0) {
    const core: Core = yield* Effect.promise(() => import("@infrawrench/client-core"));
    yield* Print.line(c.dim("KPIs"));
    yield* Print.table(kpis, [
      {
        header: "card",
        value: (k) => c.bold(safe(k.title) || summaryText(core, k.source)),
      },
      {
        header: "value",
        value: (k) => (k.result ? valueText(core, k.result.row) : c.red(safe(k.error ?? ""))),
      },
      {
        header: "change",
        value: (k) => {
          if (!k.result) return "";
          const result = k.result.row;
          const abs =
            result.unit instanceof Unrecognized
              ? null
              : core.formatDashboardKpiChange({ ...result, unit: result.unit });
          if (!abs) return c.dim("-");
          const pct = core.formatDashboardKpiChangePercent(result.changePercent);
          const text = `${abs}${pct ? ` (${pct})` : ""}`;
          const tone = core.kpiChangeTone(result);
          return tone === "good" ? c.green(text) : tone === "bad" ? c.red(text) : c.dim(text);
        },
      },
      {
        header: "window",
        value: (k) =>
          k.result?.row.from && k.result.row.to
            ? c.dim(`${k.result.row.from} to ${k.result.row.to}`)
            : "",
      },
    ]);
    yield* Print.line();
  }
  if (schedules.length === 0) {
    yield* Print.line(
      c.dim("No delivery schedules. Add one from the dashboard's menu (web or desktop)."),
    );
  } else {
    yield* Print.line(c.dim("Delivery"));
    for (const n of schedules) {
      const failing =
        n.lastStatus === "failed" || n.lastStatus === "partial" || n.lastStatus === "no_targets";
      const status = !n.enabled
        ? c.dim("paused")
        : failing
          ? c.red(safe(n.lastStatus ?? ""))
          : c.dim(safe(n.lastStatus ?? "not sent yet"));
      yield* Print.line(
        `  ${describeSchedule(n)} ${c.dim(`· ${describeTargets(n)}${n.attachPdf ? " · PDF attached" : ""} ·`)} ${status}`,
      );
      if (failing && n.lastError) yield* Print.line(`    ${c.red(safe(n.lastError))}`);
    }
  }
  yield* Print.line();
  yield* Print.line(
    c.dim(
      `A terminal can't draw the cards: \`infrawrench dashboards "${safe(dashboard.name)}" --format pdf\` saves the rendered dashboard.`,
    ),
  );
});

const name = Argument.String("name|id").pipe(
  Argument.withDescription("The dashboard (the words join into one name)"),
  Argument.variadic(),
);

/**
 * `infrawrench dashboards send <name|id>`: render the dashboard and deliver it
 * to every one of its schedules right now. Behind an explicit verb like
 * `reports send`: it posts into channels and inboxes.
 */
const send = Command.make(
  "send",
  { name },
  Effect.fn("dashboards.send")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const query = input.name.join(" ").trim();
    if (!query) {
      return yield* new CliFailure({
        message: "Which dashboard? `infrawrench dashboards send <name|id>`.",
      });
    }
    const org = yield* currentOrg;
    const { row: dashboard } = yield* resolveDashboard(org.id, query);
    const id = encodeURIComponent(dashboard.id);

    const schedules = yield* api.decode(Schedules, org.id, `/dashboards/${id}/notifications`);
    if (schedules.length === 0) {
      return yield* new CliFailure({
        message: `"${dashboard.name}" has no delivery schedules. Add one from the dashboard's menu (web or desktop) first.`,
      });
    }

    // Sequential: each send renders the PDF server-side, and a per-schedule
    // transcript reads better than an interleaved one.
    const results: Array<{
      notification: Schedule;
      result: typeof SendResult.Type;
      raw: Record<string, unknown>;
    }> = [];
    const failures: Array<{ notification: Schedule; error: string }> = [];
    for (const notification of schedules) {
      const path = `/dashboards/${id}/notifications/${encodeURIComponent(notification.id)}/send`;
      const sent = yield* attempt(
        api
          .json(org.id, path, { method: "POST" })
          .pipe(
            Effect.flatMap((body) =>
              Effect.all([decodeBody(SendResult, path)(body), spreadBody({}, body, path)]),
            ),
          ),
      );
      if (sent.ok) {
        results.push({ notification, result: sent.value[0], raw: sent.value[1] });
      } else {
        failures.push({ notification, error: sent.error });
      }
    }

    if (session.output === "json") {
      yield* Print.json({
        org: org.id,
        dashboard: { id: dashboard.id, name: dashboard.name },
        sent: results.map((r) => ({ notificationId: r.notification.id, ...r.raw })),
        failed: failures.map((f) => ({ notificationId: f.notification.id, error: f.error })),
      });
      if (failures.length > 0 && results.length === 0) {
        return yield* new CliFailure({ message: "Every send failed." });
      }
      return;
    }

    yield* Print.line(`${c.bold(safe(dashboard.name))} ${c.dim("· send now")}`);
    yield* Print.line();
    for (const { notification, result } of results) {
      const extras: string[] = [];
      if (result.pdfAttached) extras.push("PDF attached");
      if (result.pdfAttached && result.slack.attempted > 0) {
        extras.push(
          `PDF uploaded to ${result.slackFilesUploaded}/${result.slack.attempted} Slack channel(s)`,
        );
      }
      yield* Print.line(
        `  ${c.green("✓")} ${describeSchedule(notification)} ${c.dim(
          `· delivered to ${result.succeeded}/${result.attempted} destination(s)${
            extras.length > 0 ? `; ${extras.join(", ")}` : ""
          }`,
        )}`,
      );
    }
    for (const { notification, error } of failures) {
      yield* Print.line(`  ${c.red("✗")} ${describeSchedule(notification)} ${c.dim(`· ${error}`)}`);
    }
    if (
      results.some(
        (r) => r.result.pdfAttached && r.result.slack.succeeded > r.result.slackFilesUploaded,
      )
    ) {
      yield* Print.line();
      yield* Print.line(
        c.dim(
          "Slack channels without the file got the message only: the Slack install needs the files:write scope to upload PDFs.",
        ),
      );
    }
    if (failures.length > 0 && results.length === 0) {
      return yield* new CliFailure({ message: "Every send failed. See the errors above." });
    }
  }),
).pipe(
  Command.withDescription("Deliver a dashboard to its schedules now (PDF attached to email/Slack)"),
);

export const dashboards = Command.make(
  "dashboards",
  { name, format: pdfFormat("dashboards"), ...destination },
  Effect.fn("dashboards")(function* (input) {
    yield* requireCloud;
    // Same shape as `reports`: `send` is the explicit verb that posts into
    // channels, a positional names one, bare lists them all.
    const query = input.name.join(" ");
    if (query) return yield* showDashboard(query, input.format, destinationOf(input));
    if (input.format) {
      return yield* new CliFailure({
        message: "Which dashboard? `infrawrench dashboards <name|id> --format pdf`.",
      });
    }
    yield* listDashboards();
  }),
).pipe(
  Command.withDescription(
    "The org's dashboards and their deliveries; give a name or id for its KPI figures (--format pdf saves it)",
  ),
  Command.withSubcommands([send]),
);
