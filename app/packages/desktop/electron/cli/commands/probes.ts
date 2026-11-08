// `infrawrench probes`: synthetic HTTP uptime/latency checks, run on an
// interval from the egress proxy on Cloudflare's edge (an external vantage
// point), with `infrawrench probes <id|name>` for one probe's latency history.
//
// Cloud-only, like `alerts`: the checks run in the cloud poller and their
// results live in the cloud metric store, so a local workspace has nothing to
// list. The CLI lists; creating and editing probes lives on the web/desktop
// Probes tab (whose editor suggests endpoints from synced resources).
//
// The response shapes come from `@infrawrench/client-core` (the same
// definitions every other surface renders) so a server-side change breaks
// the CLI's build instead of its output. The imports are type-only, so the
// CLI still ships zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type { ProbeListResponse, ProbeMetricsResponse } from "@infrawrench/client-core" with {
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

const PATH = "/probes";

// `status` stays a string: the status cell already renders anything it does
// not know as pending.
const Probe = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  method: Schema.String,
  intervalSeconds: Schema.Finite,
  enabled: Schema.Boolean,
  status: Schema.String,
  lastProbeAt: Schema.NullOr(Schema.String),
  lastStatusCode: Schema.NullOr(Schema.Finite),
  lastLatencyMs: Schema.NullOr(Schema.Finite),
  lastError: Schema.NullOr(Schema.String),
  uptime24h: Schema.NullOr(Schema.Finite),
});
type Probe = typeof Probe.Type;

const Listing = wire<ProbeListResponse>()(Schema.Struct({ probes: Schema.Array(Probe) }));

/** The listing's rows as the server sent them, for `--json`. */
const RawListing = Schema.Struct({ probes: Schema.Array(Schema.Unknown) });

const Metrics = wire<ProbeMetricsResponse>()(
  Schema.Struct({
    series: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        unit: Schema.optional(Schema.String),
        points: Schema.Array(Schema.Struct({ value: Schema.Finite })),
      }),
    ),
  }),
);

/** The metrics' series as the server sent them, for `--json`. */
const RawMetrics = Schema.Struct({ series: Schema.Array(Schema.Unknown) });

function statusCell(probe: Probe): string {
  if (!probe.enabled) return c.dim("○ disabled");
  switch (probe.status) {
    case "up":
      return c.green("● up");
    case "down":
      return c.red("● down");
    default:
      return c.yellow("● pending");
  }
}

function uptimeCell(probe: Probe): string {
  if (probe.uptime24h === null) return c.dim("—");
  const pct = Number((probe.uptime24h * 100).toFixed(2));
  const text = `${pct}%`;
  if (pct >= 99.9) return c.green(text);
  if (pct >= 99) return c.yellow(text);
  return c.red(text);
}

/** One probe: its settings, state, and a 24h latency sparkline. */
const printProbeDetail = Effect.fn("probes.detail")(function* (
  orgId: string,
  probe: Probe,
  rawProbe: unknown,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const endMs = Date.now();
  const startMs = endMs - 24 * 60 * 60 * 1000;
  const params = new URLSearchParams({ startMs: String(startMs), endMs: String(endMs) });
  const path = `/probes/${encodeURIComponent(probe.id)}/metrics?${params.toString()}`;
  const body = yield* api.json(orgId, path);

  if (session.output === "json") {
    const { series } = yield* decodeBody(RawMetrics, path)(body);
    return yield* Print.json({ org: orgId, probe: rawProbe, series });
  }
  const { series } = yield* decodeBody(Metrics, path)(body);

  yield* Print.line(`${c.bold(probe.name)}  ${statusCell(probe)}`);
  yield* Print.line(c.dim(`${probe.method} ${probe.url} · every ${probe.intervalSeconds}s`));
  const facts: string[] = [];
  if (probe.uptime24h !== null) facts.push(`uptime 24h ${uptimeCell(probe)}`);
  if (probe.lastLatencyMs !== null) facts.push(`last ${probe.lastLatencyMs}ms`);
  if (probe.lastStatusCode !== null) facts.push(`HTTP ${probe.lastStatusCode}`);
  if (probe.status === "down" && probe.lastError) facts.push(c.red(probe.lastError));
  if (probe.lastProbeAt) facts.push(c.dim(`checked ${formatChangeTime(probe.lastProbeAt)}`));
  if (facts.length > 0) yield* Print.line(facts.join(c.dim(" · ")));

  // Match the latency series by label, falling back to unit so a server-side
  // label rename degrades to the right chart, never the 0/1 "Up" series.
  const latency = series.find((s) => s.label === "Latency") ?? series.find((s) => s.unit === "ms");
  const values = latency?.points.map((p) => p.value) ?? [];
  yield* Print.line();
  if (values.length === 0) {
    return yield* Print.line(c.dim("No latency samples in the last 24 hours."));
  }
  const min = Math.round(Math.min(...values));
  const max = Math.round(Math.max(...values));
  yield* Print.line(`${c.dim("latency 24h")} ${sparkline(values, Math.min(values.length, 60))}`);
  yield* Print.line(c.dim(`min ${min}ms · max ${max}ms · ${values.length} samples`));
});

export const probes = Command.make(
  "probes",
  {
    probe: Argument.String("id|name").pipe(
      Argument.withDescription("One probe, for its latency chart"),
      Argument.optional,
    ),
  },
  Effect.fn("probes")(function* ({ probe: probeArg }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "Synthetic probes live in Infrawrench Cloud. The poller runs them through the egress proxy. Drop --local.",
      });
    }
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (Option.isSome(probeArg)) {
      const wanted = probeArg.value;
      const { probes } = yield* decodeBody(Listing, PATH)(body);
      const raw = yield* decodeBody(RawListing, PATH)(body);
      const needle = wanted.toLowerCase();
      const index = [
        probes.findIndex((p) => p.id === wanted),
        probes.findIndex((p) => p.name.toLowerCase() === needle),
        probes.findIndex((p) => p.name.toLowerCase().includes(needle)),
      ].find((i) => i >= 0);
      const probe = index === undefined ? undefined : probes[index];
      if (index === undefined || !probe) {
        return yield* new CliFailure({
          message: `No probe matches "${wanted}". Run \`infrawrench probes\` to list.`,
        });
      }
      return yield* printProbeDetail(org.id, probe, raw.probes[index]);
    }

    if (session.output === "json") {
      const { probes } = yield* decodeBody(RawListing, PATH)(body);
      return yield* Print.json({ org: org.id, probes });
    }
    const { probes } = yield* decodeBody(Listing, PATH)(body);

    if (probes.length === 0) {
      return yield* Print.line(
        c.dim(
          "No probes yet. Create one from the Probes tab. The editor suggests endpoints from your synced resources.",
        ),
      );
    }

    const down = probes.filter((p) => p.status === "down").length;
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${probes.length} probe${probes.length === 1 ? "" : "s"}`,
      )}${down > 0 ? `  ${c.red(`${down} down`)}` : ""}`,
    );
    yield* Print.line();

    const columns: Column<Probe>[] = [
      { header: "", value: (p) => statusCell(p) },
      { header: "probe", value: (p) => p.name },
      { header: "endpoint", value: (p) => c.dim(`${p.method} ${p.url}`) },
      { header: "every", value: (p) => c.dim(`${p.intervalSeconds}s`), align: "right" },
      { header: "uptime 24h", value: (p) => uptimeCell(p), align: "right" },
      {
        header: "latency",
        value: (p) => (p.lastLatencyMs === null ? c.dim("—") : `${p.lastLatencyMs}ms`),
        align: "right",
      },
      {
        header: "checked",
        value: (p) => (p.lastProbeAt ? c.dim(formatChangeTime(p.lastProbeAt)) : c.dim("never")),
      },
    ];
    yield* Print.table(probes, columns);

    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Probed from outside your infrastructure, so this is the internet's view. `infrawrench probes <id|name>` charts one probe's latency.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Synthetic uptime and latency checks probed from outside your infra (give an id or name for its chart)",
  ),
);
