// `infrawrench paging`: incidents mirrored from paging providers (PagerDuty,
// incident.io), acknowledged or resolved from the terminal, plus the log of
// alerts Infrawrench opened upstream.
//
//   infrawrench paging                 open provider incidents
//   infrawrench paging --all           including resolved ones
//   infrawrench paging ack <id>        acknowledge upstream (as you)
//   infrawrench paging resolve <id>    resolve upstream (as you)
//   infrawrench paging events          what Infrawrench sent upstream lately
//
// The third kind of "incident" the CLI knows, and named so it cannot be
// confused with the other two: `incidents` is a provider's public status page,
// `declared-incidents` is what your org declared, and this is what your pager
// is ringing about. Cloud-only.
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`, so a server-side change breaks the CLI's build rather than its
// output, and the CLI still takes no runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  PagerIncidentRecord,
  PagerIncidentsResponse,
  PagingEventsResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { formatChangeTime } from "../format";
import { c, safe, type Column } from "../output";

const Incident = wire<PagerIncidentRecord>()(
  Schema.Struct({
    id: Schema.String,
    externalId: Schema.String,
    reference: Schema.NullOr(Schema.String),
    title: Schema.String,
    // The renderer falls back to "resolved" for a status it does not know.
    status: Schema.String,
    accountName: Schema.String,
    serviceName: Schema.NullOr(Schema.String),
    assignees: Schema.Array(
      Schema.Struct({ name: Schema.NullOr(Schema.String), email: Schema.NullOr(Schema.String) }),
    ),
    createdAt: Schema.String,
  }),
);
type Incident = typeof Incident.Type;

const Incidents = wire<PagerIncidentsResponse>()(
  Schema.Struct({ incidents: Schema.Array(Incident) }),
);

const Events = wire<PagingEventsResponse>()(
  Schema.Struct({
    events: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        trigger: Schema.String,
        state: Schema.String,
        pendingAction: Schema.NullOr(Schema.String),
        attempts: Schema.Finite,
        lastError: Schema.NullOr(Schema.String),
        updatedAt: Schema.String,
      }),
    ),
  }),
);
type PagingEvent = (typeof Events.Type)["events"][number];

/** An envelope's one list, kept raw for `--json`. */
const IncidentsEnvelope = Schema.Struct({ incidents: Schema.Unknown });
const EventsEnvelope = Schema.Struct({ events: Schema.Unknown });

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Paging providers live in Infrawrench Cloud: the incidents are mirrored per organization. Drop --local.",
    });
  }
});

// Closed enums, so printed without safe(); anything else reads as resolved.
function statusCell(status: string): string {
  switch (status) {
    case "triggered":
      return c.red("● triggered");
    case "acknowledged":
      return c.yellow("● acknowledged");
    default:
      return c.dim("○ resolved");
  }
}

/** Find an incident by Infrawrench id, provider id or reference (`#1234`, `INC-56`). */
const findIncident = (list: ReadonlyArray<Incident>, arg: string) => {
  const needle = arg.toLowerCase();
  const found =
    list.find((i) => i.id === arg) ??
    list.find((i) => i.externalId === arg) ??
    list.find((i) => (i.reference ?? "").toLowerCase() === needle) ??
    list.find(
      (i) => (i.reference ?? "").toLowerCase().replace(/^#/, "") === needle.replace(/^#/, ""),
    );
  return found
    ? Effect.succeed(found)
    : Effect.fail(
        new CliFailure({
          message: `No provider incident matches "${arg}". Run \`infrawrench paging\` to list.`,
        }),
      );
};

/**
 * `paging ack|acknowledge|resolve <id|reference>`: writes back to the
 * provider as you. One command per spelling, so the usage line names the
 * word that was typed.
 */
const action = (name: string, verb: "acknowledge" | "resolve") =>
  Command.make(
    name,
    {
      target: Argument.String("id|reference").pipe(
        Argument.withDescription("The incident: its id, the provider's id or a reference (#1234)"),
        Argument.optional,
      ),
    },
    Effect.fn(`paging.${name}`)(function* (input) {
      yield* requireCloud;
      const session = yield* CliSession;
      const api = yield* CloudApi;
      const org = yield* currentOrg;
      if (Option.isNone(input.target)) {
        return yield* new CliFailure({
          message: `Usage: infrawrench paging ${name} <id|reference>`,
        });
      }
      const { incidents } = yield* api.decode(Incidents, org.id, "/paging-incidents?status=all");
      const incident = yield* findIncident(incidents, input.target.value);
      const path = `/paging-incidents/${encodeURIComponent(incident.id)}/${verb}`;
      const body = yield* api.json(org.id, path, { method: "POST", body: "{}" });
      if (session.output === "json") return yield* Print.json(body);
      const updated = yield* decodeBody(Incident, path)(body);
      yield* Print.line(
        `${statusCell(updated.status)}  ${safe(updated.reference ?? "")} ${safe(updated.title)} ${c.dim(
          `(${safe(updated.accountName)})`,
        )}`,
      );
    }),
  ).pipe(
    Command.withDescription(
      verb === "resolve"
        ? "Resolve a provider incident upstream, as you"
        : "Acknowledge a provider incident upstream, as you",
    ),
  );

const EVENTS_PATH = "/paging-providers/events?limit=50";

const events = Command.make(
  "events",
  {},
  Effect.fn("paging.events")(function* () {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.decode(EventsEnvelope, org.id, EVENTS_PATH);
    if (session.output === "json") return yield* Print.json({ org: org.id, events: body.events });
    const rows = (yield* decodeBody(Events, EVENTS_PATH)(body)).events;
    const columns: Column<PagingEvent>[] = [
      {
        header: "state",
        value: (e) =>
          e.pendingAction
            ? c.yellow(
                `${e.pendingAction} pending${e.attempts > 0 ? ` (${e.attempts} failed)` : ""}`,
              )
            : e.state === "resolved"
              ? c.dim(e.state)
              : e.state,
      },
      { header: "alert", value: (e) => safe(e.title) },
      { header: "trigger", value: (e) => c.dim(e.trigger) },
      { header: "updated", value: (e) => c.dim(formatChangeTime(e.updatedAt)) },
      { header: "error", value: (e) => (e.lastError ? c.red(safe(e.lastError)) : "") },
    ];
    yield* Print.table(rows, columns);
  }),
).pipe(
  Command.withDescription("The alerts Infrawrench opened upstream, and where each one got to"),
);

export const paging = Command.make(
  "paging",
  {
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Include resolved incidents"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("paging")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const path = `/paging-incidents${input.all ? "?status=all" : ""}`;
    const body = yield* api.decode(IncidentsEnvelope, org.id, path);
    if (session.output === "json") {
      return yield* Print.json({ org: org.id, incidents: body.incidents });
    }
    const { incidents } = yield* decodeBody(Incidents, path)(body);
    if (incidents.length === 0) {
      return yield* Print.line(
        c.dim(
          input.all
            ? "No provider incidents mirrored. Turn mirroring on per account under Settings → On-call."
            : "Nothing open on your paging providers.",
        ),
      );
    }
    const columns: Column<Incident>[] = [
      { header: "", value: (i) => statusCell(i.status) },
      { header: "ref", value: (i) => c.dim(safe(i.reference) || "—") },
      { header: "incident", value: (i) => safe(i.title) },
      { header: "provider", value: (i) => safe(i.accountName) },
      { header: "service", value: (i) => c.dim(safe(i.serviceName) || "—") },
      {
        header: "assigned",
        value: (i) =>
          c.dim(safe(i.assignees.map((a) => a.name ?? a.email ?? "").join(", ")) || "—"),
      },
      { header: "opened", value: (i) => c.dim(formatChangeTime(i.createdAt)) },
    ];
    yield* Print.table(incidents, columns);
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "`infrawrench paging ack <ref>` / `paging resolve <ref>` writes back to the provider as you.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Incidents mirrored from PagerDuty / incident.io (open ones; --all adds resolved)",
  ),
  Command.withSubcommands([
    action("ack", "acknowledge"),
    action("acknowledge", "acknowledge"),
    action("resolve", "resolve"),
    events,
  ]),
);
