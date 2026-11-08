// `infrawrench routing`: the org's alert routing table, and the queue of
// alerts it is holding or about to escalate.
//
// Read-only, like `alerts` and `posture`: routing is org-wide configuration
// behind `org:settings:write`, and the editor is the web/desktop Notifications
// page. What the CLI is good for is the question you ask at 3am: "why did (or
// didn't) that page reach me", which is answered by seeing the rules in
// evaluation order and the deliveries that are still in flight.
//
// The response shapes come from `@infrawrench/client-core`, the same
// definitions the editor renders, so a server-side change breaks this build
// instead of its output. Type-only imports, so no new runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  AlertDeliveryRecord,
  AlertEmailSettingsView,
  AlertRulesResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { limit } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { formatChangeTime } from "../format";

// Both unions are switched on exhaustively, so their discriminants decode as
// literals; the operators only pick a wording, so they stay strings.
const Destination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("push") }),
  Schema.Struct({ kind: Schema.Literal("slack"), channelId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("msteams"), webhookId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("on-call"), scheduleId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("github-issues") }),
  Schema.Struct({ kind: Schema.Literal("email-member"), userId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("email-address"), address: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("paging-provider"),
    accountId: Schema.String,
    targetId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-on-call"),
    accountId: Schema.String,
    sourceId: Schema.String,
  }),
]);
type Destination = typeof Destination.Type;

const ValuesCondition = <F extends string>(field: F) =>
  Schema.Struct({
    field: Schema.Literal(field),
    op: Schema.String,
    values: Schema.Array(Schema.String),
  });

const Condition = Schema.Union([
  ValuesCondition("trigger"),
  Schema.Struct({ field: Schema.Literal("severity"), op: Schema.String, severity: Schema.String }),
  ValuesCondition("accountId"),
  ValuesCondition("pluginId"),
  ValuesCondition("resourceTypeId"),
  Schema.Struct({ field: Schema.Literal("amountCents"), op: Schema.String, cents: Schema.Finite }),
  Schema.Struct({ field: Schema.Literal("key"), op: Schema.String, value: Schema.String }),
  Schema.Struct({ field: Schema.Literal("text"), op: Schema.String, value: Schema.String }),
]);
type Condition = typeof Condition.Type;

const Rule = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  conditions: Schema.Array(Condition),
  destinations: Schema.Array(Destination),
  continueOnMatch: Schema.Boolean,
  quietHours: Schema.NullOr(
    Schema.Struct({
      timezone: Schema.String,
      startMinute: Schema.Finite,
      endMinute: Schema.Finite,
      days: Schema.Array(Schema.Finite),
      urgentOverride: Schema.NullOr(Schema.String),
    }),
  ),
  escalation: Schema.NullOr(
    Schema.Struct({ afterMinutes: Schema.Finite, destinations: Schema.Array(Destination) }),
  ),
});
type Rule = typeof Rule.Type;

const Named = Schema.Struct({ id: Schema.String, name: Schema.String });

const RulesResponse = wire<AlertRulesResponse>()(
  Schema.Struct({
    rules: Schema.Array(Rule),
    usingDefaults: Schema.Boolean,
    slackChannels: Schema.Array(Named),
    msTeamsWebhooks: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
    accounts: Schema.Array(Schema.Struct({ id: Schema.String, displayName: Schema.String })),
    onCallSchedules: Schema.Array(Named),
    // Absent from a server that predates email destinations.
    members: Schema.optional(
      Schema.Array(Schema.Struct({ userId: Schema.String, email: Schema.String })),
    ),
  }),
);
type RulesResponse = typeof RulesResponse.Type;

const Delivery = Schema.Struct({
  createdAt: Schema.String,
  state: Schema.String,
  severity: Schema.String,
  title: Schema.String,
  ruleName: Schema.NullOr(Schema.String),
  deliverAfter: Schema.NullOr(Schema.String),
  escalateAt: Schema.NullOr(Schema.String),
});
type Delivery = typeof Delivery.Type;

const Deliveries = wire<AlertDeliveryRecord[]>()(Schema.Array(Delivery));

const EmailSettings = wire<AlertEmailSettingsView>()(
  Schema.Struct({
    emailAvailable: Schema.Boolean,
    externalPolicy: Schema.String,
    memberDomains: Schema.Array(Schema.String),
    allowedDomains: Schema.Array(Schema.String),
    suppressions: Schema.Array(Schema.Struct({ email: Schema.String, createdAt: Schema.String })),
  }),
);

/** Names for the ids a destination holds, resolved against the same response. */
function destinationName(d: Destination, data: RulesResponse): string {
  switch (d.kind) {
    case "push":
      return "mobile push";
    case "slack": {
      const ch = data.slackChannels.find((c2) => c2.id === d.channelId);
      return ch ? `#${ch.name}` : "#(removed)";
    }
    case "msteams": {
      const hook = data.msTeamsWebhooks.find((w) => w.id === d.webhookId);
      return hook ? `teams:${hook.label}` : "teams:(removed)";
    }
    case "on-call": {
      // Named rather than "on call": an org with a primary and a secondary
      // rotation needs to see which one a rule points at.
      const schedule = data.onCallSchedules.find((sched) => sched.id === d.scheduleId);
      return schedule ? `on-call:${schedule.name}` : "on-call:(removed)";
    }
    case "github-issues":
      return "github issues";
    case "email-member": {
      const member = (data.members ?? []).find((m) => m.userId === d.userId);
      return member ? `email:${member.email}` : "email:(former member)";
    }
    case "email-address":
      return `email:${d.address}`;
    case "paging-provider": {
      // Target names are listed live from the provider; the rules response
      // carries the account, which is what tells PagerDuty from incident.io.
      const account = data.accounts.find((a) => a.id === d.accountId);
      return `${account ? account.displayName : "(removed account)"}:${d.targetId}`;
    }
    case "provider-on-call": {
      const account = data.accounts.find((a) => a.id === d.accountId);
      return `on-call:${account ? account.displayName : "(removed account)"}/${d.sourceId}`;
    }
  }
}

/** One condition as the sentence a person would say. */
function describeCondition(cond: Condition, data: RulesResponse): string {
  const list = (values: ReadonlyArray<string>): string => values.join(", ");
  switch (cond.field) {
    case "trigger":
      return `${cond.op === "in" ? "trigger is" : "trigger is not"} ${list(cond.values)}`;
    case "severity":
      return cond.op === "gte"
        ? `severity at least ${cond.severity}`
        : `severity is ${cond.severity}`;
    case "accountId": {
      const names = cond.values.map(
        (id) => data.accounts.find((a) => a.id === id)?.displayName ?? id,
      );
      return `${cond.op === "in" ? "account is" : "account is not"} ${list(names)}`;
    }
    case "pluginId":
      return `${cond.op === "in" ? "provider is" : "provider is not"} ${list(cond.values)}`;
    case "resourceTypeId":
      return `${cond.op === "in" ? "type is" : "type is not"} ${list(cond.values)}`;
    case "amountCents": {
      const dollars = (cond.cents / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });
      return cond.op === "gte" ? `amount ≥ ${dollars}` : `amount < ${dollars}`;
    }
    case "key":
      return cond.op === "eq"
        ? `name is "${cond.value}"`
        : `name ${cond.op === "contains" ? "contains" : "does not contain"} "${cond.value}"`;
    case "text":
      return `text ${cond.op === "contains" ? "contains" : "does not contain"} "${cond.value}"`;
  }
}

function minuteOfDay(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function describeRule(rule: Rule, data: RulesResponse, index: number): string[] {
  const lines: string[] = [];
  const state = rule.enabled ? "" : c.dim(" (disabled)");
  lines.push(`${c.dim(`${index + 1}.`)} ${c.bold(safe(rule.name))}${state}`);

  const when =
    rule.conditions.length === 0
      ? "every alert"
      : rule.conditions.map((cond) => describeCondition(cond, data)).join(" and ");
  lines.push(`   ${c.dim("when")}  ${safe(when)}`);

  const to =
    rule.destinations.length === 0
      ? c.dim("nowhere (this rule swallows matching alerts)")
      : safe(rule.destinations.map((d) => destinationName(d, data)).join(", "));
  lines.push(`   ${c.dim("→")}     ${to}`);

  if (rule.quietHours) {
    const q = rule.quietHours;
    const days = q.days.length === 0 ? "every day" : `ISO days ${q.days.join(",")}`;
    const override = q.urgentOverride
      ? `, except ${safe(q.urgentOverride)} and above`
      : ", holding everything";
    lines.push(
      `   ${c.dim("quiet")} ${minuteOfDay(q.startMinute)}–${minuteOfDay(q.endMinute)} ${safe(q.timezone)}, ${days}${override}`,
    );
  }
  if (rule.escalation) {
    const dests = rule.escalation.destinations.map((d) => destinationName(d, data)).join(", ");
    lines.push(
      `   ${c.dim("esc")}   unacknowledged after ${rule.escalation.afterMinutes}m → ${safe(dests)}`,
    );
  }
  // Only worth printing when it changes what happens to the rules below.
  if (rule.continueOnMatch) {
    lines.push(`   ${c.dim("also")}  keeps evaluating the rules below this one`);
  }
  return lines;
}

const requireCloud = (message: string) =>
  Effect.gen(function* () {
    const session = yield* CliSession;
    if (session.local) return yield* new CliFailure({ message });
  });

/** `infrawrench routing`: the rules, in evaluation order. */
const listRules = Effect.fn("routing")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  yield* requireCloud(
    "Alert routing lives in Infrawrench Cloud. The poller routes alerts server-side. Drop --local.",
  );
  const org = yield* currentOrg;
  const path = "/alert-rules";
  const body = yield* api.json(org.id, path);

  if (session.output === "json") {
    return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
  }
  const data = yield* decodeBody(RulesResponse, path)(body);

  if (data.usingDefaults) {
    yield* Print.line(
      c.dim(
        "No rules saved. Showing the default: everything except drift, to every connected channel and to mobile push.",
      ),
    );
    yield* Print.line("");
  }
  if (data.rules.length === 0) {
    return yield* Print.line("No routing rules, and nothing to route to.");
  }

  yield* Print.line(
    c.dim("Evaluated top to bottom; the first match wins unless a rule says otherwise."),
  );
  yield* Print.line("");
  for (const [i, rule] of data.rules.entries()) {
    for (const line of describeRule(rule, data, i)) yield* Print.line(line);
    yield* Print.line("");
  }
});

const STATE_LABELS: Partial<Record<string, string>> = {
  held: "held",
  awaiting_ack: "awaiting ack",
  sent: "sent",
  acknowledged: "acknowledged",
  escalated: "escalated",
  expired: "given up",
};

/** `infrawrench routing queue`: held and escalating alerts. */
const queue = Command.make(
  "queue",
  { limit: limit.pipe(Flag.withDescription("Deliveries to show (default 50, max 200)")) },
  Effect.fn("routing.queue")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud("Alert routing lives in Infrawrench Cloud. Drop --local.");
    const org = yield* currentOrg;
    const wanted = Option.getOrElse(input.limit, () => 50);
    const path = `/alert-rules/deliveries?limit=${Math.min(Math.max(wanted, 1), 200)}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      const deliveries = yield* decodeBody(Schema.Array(Schema.Unknown), path)(body);
      return yield* Print.json({ org: org.id, deliveries });
    }
    const rows = yield* decodeBody(Deliveries, path)(body);
    if (rows.length === 0) return yield* Print.line("Nothing held or escalating.");

    const columns: Array<Column<Delivery>> = [
      { header: "WHEN", value: (r) => formatChangeTime(r.createdAt) },
      { header: "STATE", value: (r) => STATE_LABELS[r.state] ?? safe(r.state) },
      { header: "SEVERITY", value: (r) => safe(r.severity) },
      { header: "ALERT", value: (r) => safe(r.title) },
      { header: "RULE", value: (r) => safe(r.ruleName ?? "—") },
      {
        header: "DUE",
        value: (r) =>
          r.deliverAfter
            ? `sends ${formatChangeTime(r.deliverAfter)}`
            : r.escalateAt
              ? `escalates ${formatChangeTime(r.escalateAt)}`
              : "—",
      },
    ];
    yield* Print.table(rows, columns);
  }),
).pipe(Command.withDescription("Alerts held for quiet hours or awaiting an acknowledgement"));

/**
 * `infrawrench routing email`: the alert email policy and who unsubscribed.
 * The second question after "why didn't that page reach me" when the answer
 * is an inbox: an address outside the allowed domains, or one that clicked
 * the unsubscribe link, is silently skipped at send time.
 */
const email = Command.make(
  "email",
  {},
  Effect.fn("routing.email")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud("Alert email is sent by Infrawrench Cloud. Drop --local.");
    const org = yield* currentOrg;
    const path = "/alert-email/settings";
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const view = yield* decodeBody(EmailSettings, path)(body);

    if (!view.emailAvailable) {
      yield* Print.line(
        c.yellow("This deployment has no mail provider configured: alert email is never sent."),
      );
      yield* Print.line("");
    }
    const policy =
      view.externalPolicy === "any"
        ? "any address"
        : `member domains (${view.memberDomains.join(", ") || "none"})` +
          (view.allowedDomains.length > 0 ? ` plus ${view.allowedDomains.join(", ")}` : "");
    yield* Print.line(`${c.dim("extra addresses")}  ${safe(policy)}`);
    yield* Print.line("");

    if (view.suppressions.length === 0) return yield* Print.line("Nobody has unsubscribed.");
    yield* Print.line(c.bold("Unsubscribed"));
    yield* Print.table(view.suppressions, [
      { header: "ADDRESS", value: (s) => safe(s.email) },
      { header: "SINCE", value: (s) => formatChangeTime(s.createdAt) },
    ]);
  }),
).pipe(Command.withDescription("The alert email policy and the addresses that unsubscribed"));

export const routing = Command.make("routing", {}, listRules).pipe(
  Command.withDescription("Alert routing rules, in evaluation order"),
  Command.withSubcommands([queue, email]),
);
