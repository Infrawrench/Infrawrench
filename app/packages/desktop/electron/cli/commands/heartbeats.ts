// `infrawrench heartbeats`: heartbeat monitors for scheduled jobs, each with
// its status, schedule and last ping, and `infrawrench heartbeats <id|name>`
// for one heartbeat's ping URL, recent pings and run durations.
//
// Cloud-only, like `probes`: pings land on the cloud app and the deadline
// sweep runs in the cloud poller. The CLI lists; creating and editing lives on
// the web/desktop Heartbeats tab (whose editor reads schedules from synced
// resources) and in the Terraform provider.
//
// The response shapes come from `@infrawrench/client-core`, type-only, so a
// server-side change breaks the CLI's build instead of its output and the CLI
// still ships zero new runtime dependencies. Enums the server may extend
// (`status`, `kind`) stay strings: an unknown value renders, never fails.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type { HeartbeatListResponse, HeartbeatPingsResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, type Column } from "../output";
import { sparkline } from "../charts";
import { formatChangeTime } from "../format";

const PATH = "/heartbeats";

const Heartbeat = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scheduleKind: Schema.String,
  cronExpression: Schema.NullOr(Schema.String),
  timezone: Schema.String,
  intervalMinutes: Schema.NullOr(Schema.Finite),
  graceMinutes: Schema.Finite,
  enabled: Schema.Boolean,
  status: Schema.String,
  downReason: Schema.NullOr(Schema.String),
  pingUrl: Schema.String,
  lastPingAt: Schema.NullOr(Schema.String),
  lastDurationMs: Schema.NullOr(Schema.Finite),
  nextExpectedAt: Schema.NullOr(Schema.String),
});
type Heartbeat = typeof Heartbeat.Type;

const Listing = wire<HeartbeatListResponse>()(
  Schema.Struct({ heartbeats: Schema.Array(Heartbeat) }),
);
const RawListing = Schema.Struct({ heartbeats: Schema.Array(Schema.Unknown) });

const Pings = wire<HeartbeatPingsResponse>()(
  Schema.Struct({
    pings: Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        receivedAt: Schema.String,
        durationMs: Schema.NullOr(Schema.Finite),
        body: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const RawPings = Schema.Struct({ pings: Schema.Array(Schema.Unknown) });

function statusCell(h: Heartbeat): string {
  if (!h.enabled) return c.dim("○ paused");
  switch (h.status) {
    case "up":
      return c.green("● up");
    case "down":
      return c.red(h.downReason === "failed" ? "● failed" : "● missed");
    default:
      return c.yellow("● new");
  }
}

function scheduleCell(h: Heartbeat): string {
  if (h.scheduleKind === "cron" && h.cronExpression) {
    return h.timezone === "UTC" ? h.cronExpression : `${h.cronExpression} (${h.timezone})`;
  }
  const n = h.intervalMinutes ?? 0;
  if (n > 0 && n % 1440 === 0) return `every ${n / 1440}d`;
  if (n > 0 && n % 60 === 0) return `every ${n / 60}h`;
  return `every ${n}m`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One heartbeat: its ping URL, schedule, recent pings and a run-duration sparkline. */
const printDetail = Effect.fn("heartbeats.detail")(function* (
  orgId: string,
  heartbeat: Heartbeat,
  rawHeartbeat: unknown,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const path = `/heartbeats/${encodeURIComponent(heartbeat.id)}/pings`;
  const body = yield* api.json(orgId, path);

  if (session.output === "json") {
    const { pings } = yield* decodeBody(RawPings, path)(body);
    return yield* Print.json({ org: orgId, heartbeat: rawHeartbeat, pings });
  }
  const { pings } = yield* decodeBody(Pings, path)(body);

  yield* Print.line(`${c.bold(heartbeat.name)}  ${statusCell(heartbeat)}`);
  yield* Print.line(
    c.dim(`${scheduleCell(heartbeat)} · grace ${heartbeat.graceMinutes}m`) +
      (heartbeat.nextExpectedAt
        ? c.dim(` · next due ${formatChangeTime(heartbeat.nextExpectedAt)}`)
        : ""),
  );
  yield* Print.line(`${c.dim("ping")} ${heartbeat.pingUrl}`);
  yield* Print.line(c.dim(`     append /start before a run and /fail on failure`));

  const durations = pings
    .filter((p) => p.durationMs !== null)
    .map((p) => p.durationMs!)
    .reverse();
  if (durations.length > 0) {
    yield* Print.line();
    yield* Print.line(
      `${c.dim("run duration")} ${sparkline(durations, Math.min(durations.length, 60))}`,
    );
    yield* Print.line(
      c.dim(
        `min ${duration(Math.min(...durations))} · max ${duration(Math.max(...durations))} · ${durations.length} runs`,
      ),
    );
  }

  yield* Print.line();
  if (pings.length === 0) return yield* Print.line(c.dim("No pings yet."));
  for (const ping of pings.slice(0, 15)) {
    const kind =
      ping.kind === "fail"
        ? c.red("fail   ")
        : ping.kind === "start"
          ? c.dim("start  ")
          : c.green("success");
    const parts = [kind, c.dim(formatChangeTime(ping.receivedAt))];
    if (ping.durationMs !== null) parts.push(duration(ping.durationMs));
    if (ping.body) parts.push(c.dim(ping.body.split("\n")[0]!.slice(0, 80)));
    yield* Print.line(parts.join("  "));
  }
});

export const heartbeats = Command.make(
  "heartbeats",
  {
    heartbeat: Argument.String("id|name").pipe(
      Argument.withDescription("One heartbeat, for its ping URL and recent pings"),
      Argument.optional,
    ),
  },
  Effect.fn("heartbeats")(function* ({ heartbeat: wanted }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message: "Heartbeats live in Infrawrench Cloud: jobs ping the cloud app. Drop --local.",
      });
    }
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (Option.isSome(wanted)) {
      const { heartbeats: list } = yield* decodeBody(Listing, PATH)(body);
      const raw = yield* decodeBody(RawListing, PATH)(body);
      const needle = wanted.value.toLowerCase();
      const index = [
        list.findIndex((h) => h.id === wanted.value),
        list.findIndex((h) => h.name.toLowerCase() === needle),
        list.findIndex((h) => h.name.toLowerCase().includes(needle)),
      ].find((i) => i >= 0);
      const found = index === undefined ? undefined : list[index];
      if (index === undefined || !found) {
        return yield* new CliFailure({
          message: `No heartbeat matches "${wanted.value}". Run \`infrawrench heartbeats\` to list.`,
        });
      }
      return yield* printDetail(org.id, found, raw.heartbeats[index]);
    }

    if (session.output === "json") {
      const { heartbeats: list } = yield* decodeBody(RawListing, PATH)(body);
      return yield* Print.json({ org: org.id, heartbeats: list });
    }
    const { heartbeats: list } = yield* decodeBody(Listing, PATH)(body);
    if (list.length === 0) {
      return yield* Print.line(
        c.dim("No heartbeats yet. Create one from the Heartbeats tab or a scheduled resource."),
      );
    }

    const down = list.filter((h) => h.enabled && h.status === "down").length;
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${list.length} heartbeat${list.length === 1 ? "" : "s"}`,
      )}${down > 0 ? `  ${c.red(`${down} down`)}` : ""}`,
    );
    yield* Print.line();

    const columns: Column<Heartbeat>[] = [
      { header: "", value: (h) => statusCell(h) },
      { header: "heartbeat", value: (h) => h.name },
      { header: "schedule", value: (h) => c.dim(scheduleCell(h)) },
      { header: "grace", value: (h) => c.dim(`${h.graceMinutes}m`), align: "right" },
      {
        header: "last ping",
        value: (h) => (h.lastPingAt ? c.dim(formatChangeTime(h.lastPingAt)) : c.dim("never")),
      },
      {
        header: "last run",
        value: (h) => (h.lastDurationMs === null ? c.dim("-") : duration(h.lastDurationMs)),
        align: "right",
      },
    ];
    yield* Print.table(list, columns);
    yield* Print.line();
    yield* Print.line(
      c.dim("`infrawrench heartbeats <id|name>` shows one heartbeat's ping URL and recent runs."),
    );
  }),
).pipe(
  Command.withDescription(
    "Heartbeat monitors for scheduled jobs (give an id or name for its ping URL and runs)",
  ),
);
