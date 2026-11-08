// `infrawrench webhooks`: the org's event subscriptions (signed webhooks,
// EventBridge buses, Pub/Sub topics receiving Infrawrench's own events).
//
//   infrawrench webhooks [list]               every subscription and its health
//   infrawrench webhooks test <id|name>       send an infrawrench.test event now
//   infrawrench webhooks deliveries [id|name] the delivery log, newest first
//
// Read and test only: creating one shows a signing secret once, which is a
// settings-page (or Terraform) job. Cloud-only. Type-only imports from
// client-core, so the CLI still takes no runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type { EventDelivery, EventSubscription } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody, type OrgInfo } from "../effect/cloud-api";
import { CliExit, CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { formatChangeTime } from "../format";

const PATH = "/event-subscriptions";

/** What finding a subscription by id or name reads. */
const Named = Schema.Struct({ id: Schema.String, name: Schema.String });
type Named = typeof Named.Type;

const NamedList = wire<{ subscriptions: EventSubscription[] }>()(
  Schema.Struct({ subscriptions: Schema.Array(Named) }),
);

// `destination.kind` stays a string, so a destination kind from a newer
// server prints its label instead of failing the listing.
const Subscription = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  destination: Schema.Struct({ kind: Schema.String, url: Schema.optional(Schema.String) }),
  destinationLabel: Schema.String,
  disabledReason: Schema.NullOr(Schema.String),
  consecutiveFailures: Schema.Finite,
  eventTypes: Schema.Array(Schema.String),
  lastSuccessAt: Schema.NullOr(Schema.String),
});
type Subscription = typeof Subscription.Type;

const Listing = wire<{ subscriptions: EventSubscription[] }>()(
  Schema.Struct({ subscriptions: Schema.Array(Subscription) }),
);

/** The listing's rows as the server sent them, for `--json`. */
const RawListing = Schema.Struct({ subscriptions: Schema.Array(Schema.Unknown) });

// `state` stays a string: the state cell renders anything it does not know as pending.
const Delivery = Schema.Struct({
  subscriptionId: Schema.String,
  eventType: Schema.String,
  state: Schema.String,
  attemptCount: Schema.Finite,
  responseStatus: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
  test: Schema.Boolean,
  createdAt: Schema.String,
});
type Delivery = typeof Delivery.Type;

const TestResult = wire<{ delivery: EventDelivery }>()(Schema.Struct({ delivery: Delivery }));
const RawTestResult = Schema.Struct({ delivery: Schema.Unknown });

const Deliveries = wire<{ deliveries: EventDelivery[] }>()(
  Schema.Struct({ deliveries: Schema.Array(Delivery) }),
);
const RawDeliveries = Schema.Struct({ deliveries: Schema.Array(Schema.Unknown) });

function destination(s: Subscription): string {
  return s.destination.kind === "webhook" ? (s.destination.url ?? "") : s.destinationLabel;
}

// Closed enums, so printed without safe().
function healthCell(s: Subscription): string {
  if (!s.enabled) return s.disabledReason ? c.red("● auto-off") : c.dim("○ off");
  if (s.consecutiveFailures > 0) return c.yellow(`● failing ×${s.consecutiveFailures}`);
  return c.green("● on");
}

function stateCell(d: Delivery): string {
  switch (d.state) {
    case "succeeded":
      return c.green("delivered");
    case "retrying":
      return c.yellow("retrying");
    case "dead":
      return c.red("failed");
    case "skipped":
      return c.dim("skipped");
    default:
      return c.dim("pending");
  }
}

const find = (list: readonly Named[], arg: string): Effect.Effect<Named, CliFailure> => {
  const needle = arg.toLowerCase();
  const found = list.find((s) => s.id === arg) ?? list.find((s) => s.name.toLowerCase() === needle);
  return found
    ? Effect.succeed(found)
    : Effect.fail(
        new CliFailure({
          message: `No event subscription matches "${arg}". Run \`infrawrench webhooks\` to list.`,
        }),
      );
};

/** The org and its subscriptions' body: every verb starts here. */
const loadSubscriptions = Effect.fn("webhooks.load")(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Event subscriptions live in Infrawrench Cloud: they deliver the organization's events. Drop --local.",
    });
  }
  const api = yield* CloudApi;
  const org: OrgInfo = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  return { org, body };
});

const target = Argument.String("id|name").pipe(
  Argument.withDescription("A subscription, by id or name"),
  Argument.optional,
);

const list = Effect.fn("webhooks.list")(function* () {
  const session = yield* CliSession;
  const { org, body } = yield* loadSubscriptions();
  if (session.output === "json") {
    const { subscriptions } = yield* decodeBody(RawListing, PATH)(body);
    return yield* Print.json({ org: org.id, subscriptions });
  }
  const { subscriptions } = yield* decodeBody(Listing, PATH)(body);
  if (subscriptions.length === 0) {
    return yield* Print.line(
      c.dim(
        "No event subscriptions. Add one under Settings → Notifications → Event subscriptions.",
      ),
    );
  }
  const columns: Column<Subscription>[] = [
    { header: "", value: healthCell },
    { header: "name", value: (s) => safe(s.name) },
    { header: "destination", value: (s) => safe(destination(s)) },
    {
      header: "events",
      value: (s) => (s.eventTypes.length === 0 ? c.dim("all") : safe(s.eventTypes.join(", "))),
    },
    {
      header: "last delivered",
      value: (s) => c.dim(s.lastSuccessAt ? formatChangeTime(s.lastSuccessAt) : "never"),
    },
  ];
  yield* Print.table(subscriptions, columns);
  for (const s of subscriptions) {
    if (s.disabledReason) yield* Print.line(c.red(`${safe(s.name)}: ${safe(s.disabledReason)}`));
  }
});

const test = Command.make(
  "test",
  { target },
  Effect.fn("webhooks.test")(function* ({ target }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { org, body } = yield* loadSubscriptions();
    if (Option.isNone(target)) {
      return yield* new CliFailure({ message: "Usage: infrawrench webhooks test <id|name>" });
    }
    const { subscriptions } = yield* decodeBody(NamedList, PATH)(body);
    const s = yield* find(subscriptions, target.value);
    const path = `/event-subscriptions/${encodeURIComponent(s.id)}/test`;
    const result = yield* api.json(org.id, path, { method: "POST", body: "{}" });
    if (session.output === "json") {
      return yield* Print.json((yield* decodeBody(RawTestResult, path)(result)).delivery);
    }
    const { delivery } = yield* decodeBody(TestResult, path)(result);
    const status = delivery.responseStatus !== null ? ` HTTP ${delivery.responseStatus}` : "";
    if (delivery.state === "succeeded") {
      return yield* Print.line(`${c.green("✓")} ${safe(s.name)}: test delivered${status}`);
    }
    if (delivery.state === "pending") {
      return yield* Print.line(
        `${c.yellow("…")} ${safe(s.name)}: test queued; it goes out within a minute`,
      );
    }
    yield* Print.line(
      `${c.red("✗")} ${safe(s.name)}:${status} ${safe(delivery.error ?? "failed")}`,
    );
    return yield* new CliExit({ exitCode: 1 });
  }),
).pipe(Command.withDescription("Send an infrawrench.test event to one subscription now"));

const deliveries = Command.make(
  "deliveries",
  { target },
  Effect.fn("webhooks.deliveries")(function* ({ target }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { org, body } = yield* loadSubscriptions();
    const { subscriptions } = yield* decodeBody(NamedList, PATH)(body);
    const s = Option.isSome(target) ? yield* find(subscriptions, target.value) : null;
    const path = `/event-subscriptions/deliveries?limit=50${s ? `&subscriptionId=${encodeURIComponent(s.id)}` : ""}`;
    const log = yield* api.json(org.id, path);
    if (session.output === "json") {
      const { deliveries } = yield* decodeBody(RawDeliveries, path)(log);
      return yield* Print.json({ org: org.id, deliveries });
    }
    const { deliveries } = yield* decodeBody(Deliveries, path)(log);
    if (deliveries.length === 0) {
      return yield* Print.line(c.dim("No deliveries in the last 30 days."));
    }
    const names = new Map(subscriptions.map((x) => [x.id, x.name]));
    const columns: Column<Delivery>[] = [
      { header: "state", value: stateCell },
      { header: "event", value: (d) => safe(d.eventType) + (d.test ? c.dim(" (test)") : "") },
      ...(s
        ? []
        : [
            {
              header: "subscription",
              value: (d: Delivery) => safe(names.get(d.subscriptionId) ?? d.subscriptionId),
            },
          ]),
      { header: "tries", value: (d) => String(d.attemptCount) },
      {
        header: "status",
        value: (d) => (d.responseStatus === null ? c.dim("-") : String(d.responseStatus)),
      },
      { header: "when", value: (d) => c.dim(formatChangeTime(d.createdAt)) },
      { header: "error", value: (d) => (d.error ? c.red(safe(d.error)) : "") },
    ];
    yield* Print.table(deliveries, columns);
  }),
).pipe(Command.withDescription("The delivery log, newest first, for one subscription or all"));

export const webhooks = Command.make("webhooks", {}, list).pipe(
  Command.withDescription(
    "Event subscriptions (signed webhooks, EventBridge, Pub/Sub) and their health",
  ),
  Command.withSubcommands([
    Command.make("list", {}, list).pipe(
      Command.withDescription("Every subscription and its health"),
    ),
    test,
    deliveries,
  ]),
);
