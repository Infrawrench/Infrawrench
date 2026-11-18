// `infrawrench game-days`: planned, controlled failures and how fast the org
// noticed and recovered.
//
//   infrawrench game-days                    every game day, newest start first
//   infrawrench game-days <id|name>          one game day's report
//   infrawrench game-days abort <id|name>    undo the failure now (or cancel an armed one)
//
// Cloud-only: the cloud poller injects, watches and undoes the failure. The
// CLI reads, and offers the one action that only ever puts things back:
// abort. Planning and arming a game day stay on the web/desktop tab, where the
// dry run and the blast radius are shown before a person confirms.
//
// Types come from `@infrawrench/client-core` type-only and are checked by
// `wire`; the report arithmetic is loaded with a dynamic import, the main
// project's rule for client-core runtime code. Enums the server may extend
// decode with `knownOr`, so a newer status still renders.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  GameDay,
  GameDayDetail,
  GameDayList,
  GameDayStatus,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { formatChangeTime } from "../format";
import { c, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const PATH = "/game-days";

const STATUSES = [
  "planned",
  "armed",
  "injecting",
  "running",
  "reverting",
  "recovering",
  "completed",
  "cancelled",
  "undo_failed",
] as const;

const DETECTORS = [
  "probe_failure",
  "probe_alert",
  "metric_alert",
  "slo_burn",
  "incident",
  "alert",
  "page",
  "acknowledge",
] as const;

const Instant = Schema.NullOr(Schema.String);

const Signals = Schema.Struct({
  probeFailedAt: Instant,
  probeDownAt: Instant,
  metricAlertAt: Instant,
  sloBurnAt: Instant,
  incidentDeclaredAt: Instant,
  alertedAt: Instant,
  pagedAt: Instant,
  acknowledgedAt: Instant,
});

const Target = Schema.Struct({
  displayName: Schema.String,
  actionLabel: Schema.String,
  undoLabel: Schema.String,
  state: Schema.String,
  stateBefore: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});

const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  serviceName: Schema.NullOr(Schema.String),
  status: knownOr(STATUSES),
  endReason: Schema.NullOr(Schema.String),
  startsAt: Schema.String,
  durationMinutes: Schema.Finite,
  injectedAt: Instant,
  endsAt: Instant,
  undoneAt: Instant,
  recoveredAt: Instant,
  lastError: Schema.NullOr(Schema.String),
  signals: Signals,
  watchedProbes: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  watchedSloIds: Schema.Array(Schema.String),
  targets: Schema.Array(Target),
});
type Row = typeof Row.Type;

const Listing = wire<GameDayList>()(Schema.Struct({ gameDays: Schema.Array(Row) }));

/** What finding a game day by id or name reads. */
const NamedListing = wire<GameDayList>()(
  Schema.Struct({
    gameDays: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }),
);

/** The listing's rows as the server sent them, for `--json`. */
const RawListing = Schema.Struct({ gameDays: Schema.Array(Schema.Unknown) });

const Detail = wire<GameDayDetail>()(
  Schema.Struct({
    gameDay: Row,
    alerts: Schema.Array(
      Schema.Struct({
        at: Schema.String,
        title: Schema.String,
        trigger: Schema.String,
        related: Schema.Boolean,
        paged: Schema.Boolean,
        unrouted: Schema.Boolean,
      }),
    ),
    report: Schema.Struct({
      timeToDetectMs: Schema.NullOr(Schema.Finite),
      timeToPageMs: Schema.NullOr(Schema.Finite),
      timeToAcknowledgeMs: Schema.NullOr(Schema.Finite),
      timeToRecoverMs: Schema.NullOr(Schema.Finite),
      detectors: Schema.Array(
        Schema.Struct({
          detector: knownOr(DETECTORS),
          at: Instant,
          afterMs: Schema.NullOr(Schema.Finite),
          measurable: Schema.Boolean,
        }),
      ),
    }),
  }),
);

function statusCell(status: Row["status"]): string {
  if (status instanceof Unrecognized) return c.dim(`● ${safe(status.raw)}`);
  switch (status) {
    case "planned":
      return c.dim("○ planned");
    case "armed":
      return c.yellow("● armed");
    case "injecting":
      return c.red("● injecting");
    case "running":
      return c.red("● running");
    case "reverting":
      return c.red("● undoing");
    case "recovering":
      return c.yellow("● recovering");
    case "completed":
      return c.green("● completed");
    case "cancelled":
      return c.dim("○ cancelled");
    case "undo_failed":
      return c.red("● undo failed");
  }
}

const DETECTOR_LABELS: Record<(typeof DETECTORS)[number], string> = {
  probe_failure: "first failed probe check",
  probe_alert: "probe declared down",
  metric_alert: "metric alert",
  slo_burn: "SLO burn alert",
  incident: "incident declared",
  alert: "alert sent",
  page: "on-call paged",
  acknowledge: "page acknowledged",
};

/** A status this build does not know reads as still in progress. */
function reportable(
  row: Row,
): Pick<
  GameDay,
  | "status"
  | "injectedAt"
  | "undoneAt"
  | "recoveredAt"
  | "signals"
  | "watchedProbes"
  | "watchedSloIds"
> {
  const status: GameDayStatus = row.status instanceof Unrecognized ? "running" : row.status;
  return {
    status,
    injectedAt: row.injectedAt,
    undoneAt: row.undoneAt,
    recoveredAt: row.recoveredAt,
    signals: row.signals,
    watchedProbes: row.watchedProbes.map((p) => ({ ...p, status: "unknown" as const })),
    watchedSloIds: [...row.watchedSloIds],
  };
}

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Game days live in Infrawrench Cloud. The poller injects and undoes them. Drop --local.",
    });
  }
});

/** One game day by id, exact name or a name fragment. */
const findGameDay = Effect.fn("gameDays.find")(function* (orgId: string, wanted: string) {
  const api = yield* CloudApi;
  const body = yield* api.json(orgId, PATH);
  const { gameDays } = yield* decodeBody(NamedListing, PATH)(body);
  const needle = wanted.toLowerCase();
  const found =
    gameDays.find((g) => g.id === wanted) ??
    gameDays.find((g) => g.name.toLowerCase() === needle) ??
    gameDays.find((g) => g.name.toLowerCase().includes(needle));
  if (!found) {
    return yield* new CliFailure({
      message: `No game day matches "${wanted}". Run \`infrawrench game-days\` to list.`,
    });
  }
  return found;
});

const printReport = Effect.fn("gameDays.report")(function* (
  core: Core,
  orgId: string,
  gameDayId: string,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const path = `${PATH}/${encodeURIComponent(gameDayId)}`;
  const body = yield* api.json(orgId, path);
  if (session.output === "json")
    return yield* Print.json(yield* spreadBody({ org: orgId }, body, path));
  const { gameDay: g, alerts, report } = yield* decodeBody(Detail, path)(body);
  const d = core.formatGameDayDuration;

  yield* Print.line(`${c.bold(safe(g.name))}  ${statusCell(g.status)}`);
  const facts = [`starts ${formatChangeTime(g.startsAt)}`, `time limit ${g.durationMinutes} min`];
  if (g.serviceName) facts.push(`service ${safe(g.serviceName)}`);
  if (g.endReason) facts.push(safe(g.endReason.replaceAll("_", " ")));
  yield* Print.line(c.dim(facts.join(" · ")));
  if (g.description) yield* Print.line(safe(g.description));
  if (g.lastError) yield* Print.line(c.red(safe(g.lastError)));
  yield* Print.line();

  if (g.injectedAt) {
    yield* Print.line(
      [
        `detect ${d(report.timeToDetectMs)}`,
        `page ${d(report.timeToPageMs)}`,
        `acknowledge ${d(report.timeToAcknowledgeMs)}`,
        `recover ${d(report.timeToRecoverMs)}`,
      ].join(c.dim(" · ")),
    );
    yield* Print.line();
    yield* Print.table(report.detectors, [
      {
        header: "detector",
        value: (r) =>
          r.detector instanceof Unrecognized ? safe(r.detector.raw) : DETECTOR_LABELS[r.detector],
      },
      {
        header: "fired",
        value: (r) =>
          r.at
            ? c.green(formatChangeTime(r.at))
            : r.measurable
              ? c.red("did not fire")
              : c.dim("not set up"),
      },
      {
        header: "after injection",
        value: (r) => (r.afterMs === null ? c.dim("-") : d(r.afterMs)),
        align: "right",
      },
    ]);
    yield* Print.line();
  }

  yield* Print.line(c.bold("targets"));
  yield* Print.table(
    g.targets,
    [
      { header: "resource", value: (t) => safe(t.displayName) },
      { header: "failure", value: (t) => safe(t.actionLabel) },
      { header: "state", value: (t) => safe(t.state.replaceAll("_", " ")) },
      { header: "before", value: (t) => c.dim(safe(t.stateBefore ?? "-")) },
      { header: "error", value: (t) => (t.lastError ? c.red(safe(t.lastError)) : "") },
    ],
    { indent: 2 },
  );

  if (alerts.length > 0) {
    yield* Print.line();
    yield* Print.line(c.bold("alerts during the game day"));
    for (const a of alerts) {
      const marks = [a.paged ? c.yellow("paged") : "", a.unrouted ? c.red("unrouted") : ""]
        .filter(Boolean)
        .join(" ");
      const title = a.related ? safe(a.title) : c.dim(safe(a.title));
      yield* Print.line(`  ${c.dim(formatChangeTime(a.at))}  ${title}${marks ? `  ${marks}` : ""}`);
    }
  }
});

const abort = Command.make(
  "abort",
  {
    target: Argument.String("id|name").pipe(
      Argument.withDescription("The game day to abort"),
      Argument.optional,
    ),
  },
  Effect.fn("gameDays.abort")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    if (Option.isNone(input.target)) {
      return yield* new CliFailure({ message: "Usage: infrawrench game-days abort <id|name>" });
    }
    const found = yield* findGameDay(org.id, input.target.value);
    const path = `${PATH}/${encodeURIComponent(found.id)}/abort`;
    const body = yield* api.json(org.id, path, { method: "POST" });
    if (session.output === "json") return yield* Print.json(body);
    const updated = yield* decodeBody(Row, path)(body);
    yield* Print.line(`${statusCell(updated.status)}  ${c.bold(safe(updated.name))}`);
    yield* Print.line(
      c.dim(
        updated.status === "cancelled"
          ? "Cancelled before it started."
          : "Abort requested: the poller undoes the failure within seconds.",
      ),
    );
  }),
).pipe(Command.withDescription("Undo a game day's failure now, or cancel an armed one"));

export const gameDays = Command.make(
  "game-days",
  {
    gameDay: Argument.String("id|name").pipe(
      Argument.withDescription("One game day, for its report"),
      Argument.optional,
    ),
  },
  Effect.fn("gameDays")(function* ({ gameDay: wanted }) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const core: Core = yield* Effect.promise(() => import("@infrawrench/client-core"));
    const org = yield* currentOrg;

    if (Option.isSome(wanted)) {
      const found = yield* findGameDay(org.id, wanted.value);
      return yield* printReport(core, org.id, found.id);
    }

    const body = yield* api.json(org.id, PATH);
    if (session.output === "json") {
      const { gameDays } = yield* decodeBody(RawListing, PATH)(body);
      return yield* Print.json({ org: org.id, gameDays });
    }
    const { gameDays } = yield* decodeBody(Listing, PATH)(body);
    if (gameDays.length === 0) {
      return yield* Print.line(c.dim("No game days yet. Plan one from the Game days tab."));
    }

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${gameDays.length} game day${gameDays.length === 1 ? "" : "s"}`)}`,
    );
    yield* Print.line();
    const columns: Column<Row>[] = [
      { header: "", value: (g) => statusCell(g.status) },
      { header: "game day", value: (g) => safe(g.name) },
      { header: "starts", value: (g) => c.dim(formatChangeTime(g.injectedAt ?? g.startsAt)) },
      {
        header: "detected in",
        value: (g) => {
          const report = core.computeGameDayReport(reportable(g));
          if (report.state === "not_run") return c.dim("-");
          return report.timeToDetectMs === null
            ? c.red("not detected")
            : core.formatGameDayDuration(report.timeToDetectMs);
        },
        align: "right",
      },
      { header: "service", value: (g) => c.dim(safe(g.serviceName ?? "-")) },
    ];
    yield* Print.table(gameDays, columns);
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "`infrawrench game-days <id|name>` shows one report; `game-days abort <id|name>` undoes the failure now.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Game days: planned, controlled failures with time to detect, page, acknowledge and recover (give an id or name for its report)",
  ),
  Command.withSubcommands([abort]),
);
