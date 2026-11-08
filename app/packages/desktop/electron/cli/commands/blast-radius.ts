// `infrawrench blast-radius <resource-id>`: what breaks if a resource is
// deleted, from the same /blast-radius endpoint the delete dialog and the
// resource-detail tab read.
//
// It is a command of its own rather than a flag on `graph` because the report
// is not a graph: two thirds of it (soft references and measured traffic) do
// not exist as edges, and the server assembles all three together. `graph
// --resource` keeps its own blast-radius count, which is the graph's answer;
// this is the whole answer.
import type { BlastRadiusReport } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c } from "../output";

// `kind` and `direction` stay strings: both are printed (or compared) as
// they come, so a value from a newer server still renders.
const Report = wire<BlastRadiusReport>()(
  Schema.Struct({
    resource: Schema.NullOr(Schema.Struct({ displayName: Schema.String })),
    headline: Schema.String,
    dependants: Schema.Array(
      Schema.Struct({
        node: Schema.Struct({
          displayName: Schema.String,
          resourceTypeLabel: Schema.String,
          accountName: Schema.String,
        }),
        depth: Schema.Finite,
      }),
    ),
    references: Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        name: Schema.String,
        detail: Schema.optional(Schema.String),
        userFacing: Schema.optional(Schema.Boolean),
      }),
    ),
    flowPeers: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        direction: Schema.String,
        scope: Schema.String,
        bytes: Schema.Finite,
      }),
    ),
    unchecked: Schema.Array(Schema.Struct({ reason: Schema.String })),
  }),
);

export const blastRadius = Command.make(
  "blast-radius",
  {
    resourceId: Argument.String("resource-id").pipe(
      Argument.withDescription("The resource to report on (see `infrawrench ls`)"),
      Argument.optional,
    ),
  },
  Effect.fn("blast-radius")(function* (input) {
    const session = yield* CliSession;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "The impact report is assembled by Infrawrench Cloud. It reads the org's dashboards, probes, leases and flow data, none of which a local workspace has.",
      });
    }
    if (Option.isNone(input.resourceId) || input.resourceId.value === "") {
      return yield* new CliFailure({
        message: "Usage: infrawrench blast-radius <resource-id>  (see `infrawrench ls`)",
      });
    }
    const resourceId = input.resourceId.value;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const path = `/blast-radius?resourceId=${encodeURIComponent(resourceId)}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Report, path)(body);

    yield* Print.line(c.bold(report.resource?.displayName ?? resourceId));
    yield* Print.line(report.headline);
    yield* Print.line();

    if (report.dependants.length > 0) {
      yield* Print.line(c.bold("Depended on by"));
      for (const d of report.dependants) {
        const distance = d.depth === 1 ? c.red("direct") : c.dim(`${d.depth} hops`);
        yield* Print.line(
          `  ${d.node.displayName}  ${c.dim(`${d.node.resourceTypeLabel} · ${d.node.accountName}`)}  ${distance}`,
        );
      }
      yield* Print.line();
    }

    if (report.references.length > 0) {
      yield* Print.line(c.bold("Points at it"));
      for (const ref of report.references) {
        const suffix = ref.userFacing ? `  ${c.red("customer-visible")}` : "";
        yield* Print.line(
          `  ${c.dim(`[${ref.kind}]`)} ${ref.name}${ref.detail ? c.dim(`, ${ref.detail}`) : ""}${suffix}`,
        );
      }
      yield* Print.line();
    }

    if (report.flowPeers.length > 0) {
      yield* Print.line(c.bold("Talks to"));
      for (const peer of report.flowPeers) {
        const arrow = peer.direction === "egress" ? "→" : "←";
        yield* Print.line(
          `  ${arrow} ${peer.label}  ${c.dim(`${peer.scope} · ${formatBytes(peer.bytes)}`)}`,
        );
      }
      yield* Print.line();
    }

    // Always printed, including on an otherwise empty report: a silent gap is
    // how "we could not look" gets read as "there is nothing there".
    if (report.unchecked.length > 0) {
      yield* Print.line(c.bold("Not checked"));
      for (const gap of report.unchecked) yield* Print.line(`  ${c.dim(gap.reason)}`);
    } else {
      yield* Print.line(c.dim("Everything this report can look at was checked."));
    }
  }),
).pipe(
  Command.withDescription(
    "What breaks if a resource is deleted: dependants, what points at it, what talks to it",
  ),
);

/** Decimal units, matching the network-costs surfaces (`formatFlowBytes`). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
