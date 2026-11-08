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
// is ringing about. Cloud-only. Type-only imports from client-core, so the CLI
// still takes no runtime dependency.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  PagerIncidentRecord,
  PagerIncidentsResponse,
  PagingEventRecord,
  PagingEventsResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";
import { formatChangeTime } from "../format";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Paging providers live in Infrawrench Cloud: the incidents are mirrored per organization. Drop --local.",
    );
  }
}

// Closed enums, so printed without safe().
function statusCell(status: PagerIncidentRecord["status"]): string {
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
function findIncident(list: PagerIncidentRecord[], arg: string): PagerIncidentRecord {
  const needle = arg.toLowerCase();
  const found =
    list.find((i) => i.id === arg) ??
    list.find((i) => i.externalId === arg) ??
    list.find((i) => (i.reference ?? "").toLowerCase() === needle) ??
    list.find(
      (i) => (i.reference ?? "").toLowerCase().replace(/^#/, "") === needle.replace(/^#/, ""),
    );
  if (!found) {
    throw new CliError(
      `No provider incident matches "${arg}". Run \`infrawrench paging\` to list.`,
    );
  }
  return found;
}

export async function cmdPaging(ctx: CliContext, args: string[], all: boolean): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const [sub, target] = args;

  if (sub === "events") {
    await printEvents(ctx, org.id);
    return;
  }

  if (sub === "ack" || sub === "acknowledge" || sub === "resolve") {
    if (!target) throw new CliError(`Usage: infrawrench paging ${sub} <id|reference>`);
    const { incidents } = await orgFetch<PagerIncidentsResponse>(
      org.id,
      "/paging-incidents?status=all",
    );
    const incident = findIncident(incidents, target);
    const action = sub === "resolve" ? "resolve" : "acknowledge";
    const updated = await orgFetch<PagerIncidentRecord>(
      org.id,
      `/paging-incidents/${encodeURIComponent(incident.id)}/${action}`,
      { method: "POST", body: "{}" },
    );
    if (ctx.flags.output === "json") {
      printJson(updated);
      return;
    }
    println(
      `${statusCell(updated.status)}  ${safe(updated.reference ?? "")} ${safe(updated.title)} ${c.dim(
        `(${safe(updated.accountName)})`,
      )}`,
    );
    return;
  }

  if (sub) {
    throw new CliError(
      `Unknown subcommand "${sub}". Try: paging, paging ack|resolve <id>, paging events.`,
    );
  }

  const { incidents } = await orgFetch<PagerIncidentsResponse>(
    org.id,
    `/paging-incidents${all ? "?status=all" : ""}`,
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, incidents });
    return;
  }
  if (incidents.length === 0) {
    println(
      c.dim(
        all
          ? "No provider incidents mirrored. Turn mirroring on per account under Settings → On-call."
          : "Nothing open on your paging providers.",
      ),
    );
    return;
  }
  const columns: Column<PagerIncidentRecord>[] = [
    { header: "", value: (i) => statusCell(i.status) },
    { header: "ref", value: (i) => c.dim(safe(i.reference) || "—") },
    { header: "incident", value: (i) => safe(i.title) },
    { header: "provider", value: (i) => safe(i.accountName) },
    { header: "service", value: (i) => c.dim(safe(i.serviceName) || "—") },
    {
      header: "assigned",
      value: (i) => c.dim(safe(i.assignees.map((a) => a.name ?? a.email ?? "").join(", ")) || "—"),
    },
    { header: "opened", value: (i) => c.dim(formatChangeTime(i.createdAt)) },
  ];
  printTable(incidents, columns);
  println();
  println(
    c.dim(
      "`infrawrench paging ack <ref>` / `paging resolve <ref>` writes back to the provider as you.",
    ),
  );
}

async function printEvents(ctx: CliContext, orgId: string): Promise<void> {
  const { events } = await orgFetch<PagingEventsResponse>(
    orgId,
    "/paging-providers/events?limit=50",
  );
  if (ctx.flags.output === "json") {
    printJson({ org: orgId, events });
    return;
  }
  const columns: Column<PagingEventRecord>[] = [
    {
      header: "state",
      value: (e) =>
        e.pendingAction
          ? c.yellow(`${e.pendingAction} pending${e.attempts > 0 ? ` (${e.attempts} failed)` : ""}`)
          : e.state === "resolved"
            ? c.dim(e.state)
            : e.state,
    },
    { header: "alert", value: (e) => safe(e.title) },
    { header: "trigger", value: (e) => c.dim(e.trigger) },
    { header: "updated", value: (e) => c.dim(formatChangeTime(e.updatedAt)) },
    { header: "error", value: (e) => (e.lastError ? c.red(safe(e.lastError)) : "") },
  ];
  printTable(events, columns);
}
