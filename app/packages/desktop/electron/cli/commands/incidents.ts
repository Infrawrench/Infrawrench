// `infrawrench incidents`: "is it me or is it them?" in the terminal.
//
// Backed by the same /status-incidents endpoint the web banner and Changes
// page read: the cloud poller watches each provider plugin's public status
// feed, caches active incidents, and the endpoint correlates them against the
// resources the org holds; by region, resource type, or provider-wide scope.
//
// Wire types come from `@infrawrench/client-core`: the same definitions every
// other surface renders with, so a server-side change breaks the CLI's build
// instead of its output.
import type {
  OrgStatusIncidentsResponse,
  ProviderIncidentImpact,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c } from "../output";
import { formatChangeTime } from "../format";

const PATH = "/status-incidents";

// `impact` stays a string: an impact from a newer server renders as minor
// rather than failing the listing.
const Incidents = wire<OrgStatusIncidentsResponse>()(
  Schema.Struct({
    incidents: Schema.Array(
      Schema.Struct({
        pluginName: Schema.String,
        title: Schema.String,
        impact: Schema.String,
        url: Schema.optional(Schema.NullOr(Schema.String)),
        startedAt: Schema.String,
        resolvedAt: Schema.optional(Schema.NullOr(Schema.String)),
        services: Schema.Array(Schema.String),
        providerWide: Schema.Boolean,
        affectedResourceCount: Schema.Finite,
        affectedRegions: Schema.Array(Schema.String),
        sampleResources: Schema.Array(
          Schema.Struct({
            displayName: Schema.String,
            region: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
        overlappingChangeCount: Schema.Finite,
      }),
    ),
  }),
);

/** The `--json` half: the incidents exactly as the server sent them. */
const RawIncidents = Schema.Struct({ incidents: Schema.Unknown });

interface ImpactStyle {
  label: string;
  color: (s: string) => string;
}

const MINOR: ImpactStyle = { label: "minor", color: c.yellow };

const IMPACT_STYLE: Partial<Record<string, ImpactStyle>> = {
  critical: { label: "critical", color: c.red },
  major: { label: "major", color: c.yellow },
  minor: MINOR,
  maintenance: { label: "maint", color: c.dim },
} satisfies Record<ProviderIncidentImpact, ImpactStyle>;

export const incidents = Command.make(
  "incidents",
  {},
  Effect.fn("incidents")(function* () {
    const session = yield* CliSession;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "Provider status correlation is computed by Infrawrench Cloud's poller, which watches each provider's public status feed. Local-only mode has no poller, so there is nothing to correlate.",
      });
    }
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (session.output === "json") {
      const raw = yield* decodeBody(RawIncidents, PATH)(body);
      return yield* Print.json({ org: org.id, incidents: raw.incidents });
    }

    const { incidents } = yield* decodeBody(Incidents, PATH)(body);
    if (incidents.length === 0) {
      return yield* Print.line(
        c.dim(
          "No provider incidents overlap this organization. Every provider status feed we watch is clear.",
        ),
      );
    }

    const active = incidents.filter((i) => !i.resolvedAt);
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${active.length} active provider incident${active.length === 1 ? "" : "s"}, ` +
          `${incidents.length - active.length} resolved in the last 24h`,
      )}`,
    );
    yield* Print.line();

    yield* Print.table(incidents, [
      {
        header: "impact",
        value: (i) => {
          if (i.resolvedAt) return c.dim("resolved");
          const style = IMPACT_STYLE[i.impact] ?? MINOR;
          return style.color(style.label);
        },
      },
      { header: "provider", value: (i) => c.bold(i.pluginName) },
      { header: "incident", value: (i) => i.title },
      {
        header: "scope",
        value: (i) =>
          i.providerWide
            ? c.dim("provider-wide")
            : i.affectedRegions.length > 0
              ? i.affectedRegions.join(", ")
              : c.dim(i.services.slice(0, 3).join(", ") || "—"),
      },
      {
        header: "your resources",
        value: (i) =>
          i.affectedResourceCount > 0 ? c.yellow(String(i.affectedResourceCount)) : "0",
      },
      {
        header: "changes during",
        value: (i) =>
          i.overlappingChangeCount > 0 ? String(i.overlappingChangeCount) : c.dim("0"),
      },
      { header: "since", value: (i) => c.dim(formatChangeTime(i.startedAt)) },
    ]);

    for (const incident of incidents) {
      if (incident.sampleResources.length === 0) continue;
      yield* Print.line();
      yield* Print.line(
        `${c.bold(incident.pluginName)} ${c.dim("affects")} ${incident.sampleResources
          .map((r) => r.displayName + (r.region ? c.dim(` (${r.region})`) : ""))
          .join(", ")}${
          incident.affectedResourceCount > incident.sampleResources.length
            ? c.dim(` and ${incident.affectedResourceCount - incident.sampleResources.length} more`)
            : ""
        }`,
      );
      if (incident.url) yield* Print.line(c.dim(`  ${incident.url}`));
    }
  }),
).pipe(
  Command.withDescription(
    'Provider status-page incidents overlapping your resources ("is it me or is it them?")',
  ),
);
