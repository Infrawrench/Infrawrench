// `infrawrench routing` — the org's alert routing table, and the queue of
// alerts it is holding or about to escalate.
//
// Read-only, like `alerts` and `posture`: routing is org-wide configuration
// behind `org:settings:write`, and the editor is the web/desktop Notifications
// page. What the CLI is good for is the question you ask at 3am — "why did (or
// didn't) that page reach me" — which is answered by seeing the rules in
// evaluation order and the deliveries that are still in flight.
//
// The response shapes come from `@infrawrench/client-core`, the same
// definitions the editor renders, so a server-side change breaks this build
// instead of its output. Type-only imports, so no new runtime dependency.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  AlertCondition,
  AlertDeliveryRecord,
  AlertDestination,
  AlertRule,
  AlertRulesResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";
import { formatChangeTime } from "../format";

/** Shorter local name for the wire type, so the table columns stay readable. */
type Delivery = AlertDeliveryRecord;

/** Names for the ids a destination holds, resolved against the same response. */
function destinationName(d: AlertDestination, data: AlertRulesResponse): string {
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
  }
}

/** One condition as the sentence a person would say. */
function describeCondition(cond: AlertCondition, data: AlertRulesResponse): string {
  const list = (values: string[]): string => values.join(", ");
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

function describeRule(rule: AlertRule, data: AlertRulesResponse, index: number): string[] {
  const lines: string[] = [];
  const state = rule.enabled ? "" : c.dim(" (disabled)");
  lines.push(`${c.dim(`${index + 1}.`)} ${c.bold(rule.name)}${state}`);

  const when =
    rule.conditions.length === 0
      ? "every alert"
      : rule.conditions.map((cond) => describeCondition(cond, data)).join(" and ");
  lines.push(`   ${c.dim("when")}  ${when}`);

  const to =
    rule.destinations.length === 0
      ? c.dim("nowhere — this rule swallows matching alerts")
      : rule.destinations.map((d) => destinationName(d, data)).join(", ");
  lines.push(`   ${c.dim("→")}     ${to}`);

  if (rule.quietHours) {
    const q = rule.quietHours;
    const days = q.days.length === 0 ? "every day" : `ISO days ${q.days.join(",")}`;
    const override = q.urgentOverride
      ? `, except ${q.urgentOverride} and above`
      : ", holding everything";
    lines.push(
      `   ${c.dim("quiet")} ${minuteOfDay(q.startMinute)}–${minuteOfDay(q.endMinute)} ${q.timezone}, ${days}${override}`,
    );
  }
  if (rule.escalation) {
    const dests = rule.escalation.destinations.map((d) => destinationName(d, data)).join(", ");
    lines.push(
      `   ${c.dim("esc")}   unacknowledged after ${rule.escalation.afterMinutes}m → ${dests}`,
    );
  }
  // Only worth printing when it changes what happens to the rules below.
  if (rule.continueOnMatch) {
    lines.push(`   ${c.dim("also")}  keeps evaluating the rules below this one`);
  }
  return lines;
}

/** `infrawrench routing` — the rules, in evaluation order. */
export async function cmdRouting(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Alert routing lives in Infrawrench Cloud — the poller routes alerts server-side. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const data = await orgFetch<AlertRulesResponse>(org.id, "/alert-rules");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...data });
    return;
  }

  if (data.usingDefaults) {
    println(
      c.dim(
        "No rules saved — showing the default: everything except drift, to every connected channel and to mobile push.",
      ),
    );
    println("");
  }
  if (data.rules.length === 0) {
    println("No routing rules, and nothing to route to.");
    return;
  }

  println(c.dim("Evaluated top to bottom; the first match wins unless a rule says otherwise."));
  println("");
  data.rules.forEach((rule, i) => {
    for (const line of describeRule(rule, data, i)) println(line);
    println("");
  });
}

const STATE_LABELS: Record<string, string> = {
  held: "held",
  awaiting_ack: "awaiting ack",
  sent: "sent",
  acknowledged: "acknowledged",
  escalated: "escalated",
  expired: "given up",
};

/** `infrawrench routing queue` — held and escalating alerts. */
export async function cmdRoutingQueue(ctx: CliContext, limit?: number): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Alert routing lives in Infrawrench Cloud. Drop --local.");
  }
  const org = await resolveOrg(ctx);
  const rows = await orgFetch<Delivery[]>(
    org.id,
    `/alert-rules/deliveries?limit=${Math.min(Math.max(limit ?? 50, 1), 200)}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, deliveries: rows });
    return;
  }
  if (rows.length === 0) {
    println("Nothing held or escalating.");
    return;
  }

  const columns: Array<Column<Delivery>> = [
    { header: "WHEN", value: (r) => formatChangeTime(r.createdAt) },
    { header: "STATE", value: (r) => STATE_LABELS[r.state] ?? r.state },
    { header: "SEVERITY", value: (r) => r.severity },
    { header: "ALERT", value: (r) => r.title },
    { header: "RULE", value: (r) => r.ruleName ?? "—" },
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
  printTable(rows, columns);
}
