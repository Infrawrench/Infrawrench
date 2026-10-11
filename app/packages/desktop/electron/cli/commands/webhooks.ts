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
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { EventDelivery, EventSubscription } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, safe, type Column } from "../output";
import { formatChangeTime } from "../format";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Event subscriptions live in Infrawrench Cloud: they deliver the organization's events. Drop --local.",
    );
  }
}

function destination(s: EventSubscription): string {
  return s.destination.kind === "webhook" ? s.destination.url : s.destinationLabel;
}

// Closed enums, so printed without safe().
function healthCell(s: EventSubscription): string {
  if (!s.enabled) return s.disabledReason ? c.red("● auto-off") : c.dim("○ off");
  if (s.consecutiveFailures > 0) return c.yellow(`● failing ×${s.consecutiveFailures}`);
  return c.green("● on");
}

function stateCell(d: EventDelivery): string {
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

function find(list: EventSubscription[], arg: string): EventSubscription {
  const needle = arg.toLowerCase();
  const found = list.find((s) => s.id === arg) ?? list.find((s) => s.name.toLowerCase() === needle);
  if (!found) {
    throw new CliError(
      `No event subscription matches "${arg}". Run \`infrawrench webhooks\` to list.`,
    );
  }
  return found;
}

export async function cmdWebhooks(ctx: CliContext, args: string[]): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const [sub = "list", target] = args;
  const { subscriptions } = await orgFetch<{ subscriptions: EventSubscription[] }>(
    org.id,
    "/event-subscriptions",
  );

  if (sub === "test") {
    if (!target) throw new CliError("Usage: infrawrench webhooks test <id|name>");
    const s = find(subscriptions, target);
    const { delivery } = await orgFetch<{ delivery: EventDelivery }>(
      org.id,
      `/event-subscriptions/${encodeURIComponent(s.id)}/test`,
      { method: "POST", body: "{}" },
    );
    if (ctx.flags.output === "json") {
      printJson(delivery);
      return;
    }
    const status = delivery.responseStatus !== null ? ` HTTP ${delivery.responseStatus}` : "";
    if (delivery.state === "succeeded") {
      println(`${c.green("✓")} ${safe(s.name)}: test delivered${status}`);
    } else if (delivery.state === "pending") {
      println(`${c.yellow("…")} ${safe(s.name)}: test queued; it goes out within a minute`);
    } else {
      println(`${c.red("✗")} ${safe(s.name)}:${status} ${safe(delivery.error ?? "failed")}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "deliveries") {
    const s = target ? find(subscriptions, target) : null;
    const { deliveries } = await orgFetch<{ deliveries: EventDelivery[] }>(
      org.id,
      `/event-subscriptions/deliveries?limit=50${s ? `&subscriptionId=${encodeURIComponent(s.id)}` : ""}`,
    );
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, deliveries });
      return;
    }
    if (deliveries.length === 0) {
      println(c.dim("No deliveries in the last 30 days."));
      return;
    }
    const names = new Map(subscriptions.map((x) => [x.id, x.name]));
    const columns: Column<EventDelivery>[] = [
      { header: "state", value: stateCell },
      { header: "event", value: (d) => safe(d.eventType) + (d.test ? c.dim(" (test)") : "") },
      ...(s
        ? []
        : [
            {
              header: "subscription",
              value: (d: EventDelivery) => safe(names.get(d.subscriptionId) ?? d.subscriptionId),
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
    printTable(deliveries, columns);
    return;
  }

  if (sub !== "list") {
    throw new CliError(
      `Unknown subcommand "${sub}". Try: webhooks, webhooks test <id|name>, webhooks deliveries [id|name].`,
    );
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, subscriptions });
    return;
  }
  if (subscriptions.length === 0) {
    println(
      c.dim(
        "No event subscriptions. Add one under Settings → Notifications → Event subscriptions.",
      ),
    );
    return;
  }
  const columns: Column<EventSubscription>[] = [
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
  printTable(subscriptions, columns);
  const off = subscriptions.filter((s) => s.disabledReason);
  for (const s of off) println(c.red(`${safe(s.name)}: ${safe(s.disabledReason)}`));
}
