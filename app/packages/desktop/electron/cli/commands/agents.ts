import { orgFetch, resolveOrg, type CliContext } from "../context";
import { c, printJson, println, printTable, type Column } from "../output";

interface AgentRegistration {
  id: string;
  label: string | null;
  kind: string;
  prefix: string | null;
  claimedAt: string | null;
  claimedByEmail: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function relative(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusCell(row: AgentRegistration): string {
  if (row.revokedAt) return c.red("revoked");
  if (!row.claimedAt) return c.yellow("unclaimed");
  return c.green("claimed");
}

/**
 * `infrawrench agents` — the agent credentials that can reach this org.
 *
 * The same inventory the Agent Credentials settings page shows. Worth having
 * here for the same reason `hygiene` is: "what non-human things can touch our
 * cloud accounts" is a question that belongs in whatever the org already
 * reviews on a schedule, and nobody opens a settings page to check.
 */
export async function cmdAgents(ctx: CliContext): Promise<void> {
  const org = await resolveOrg(ctx);
  const rows = await orgFetch<AgentRegistration[]>(org.id, "/agent-registrations");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, agents: rows });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· agent credentials")}`);
  println();

  if (rows.length === 0) {
    println(c.dim("No agents have registered against this organization."));
    return;
  }

  const columns: Column<AgentRegistration>[] = [
    { header: "NAME", value: (r) => r.label ?? c.dim("unnamed") },
    { header: "STATUS", value: statusCell },
    { header: "CREDENTIAL", value: (r) => (r.prefix ? `${r.prefix}…` : c.dim("external")) },
    { header: "CLAIMED BY", value: (r) => r.claimedByEmail ?? c.dim("—") },
    { header: "LAST USED", value: (r) => relative(r.lastSeenAt) },
  ];
  printTable(rows, columns);

  const unclaimed = rows.filter((r) => !r.claimedAt && !r.revokedAt).length;
  if (unclaimed > 0) {
    println();
    println(
      c.yellow(
        `${unclaimed} unclaimed. Their workspaces are deleted 24 hours after they were created.`,
      ),
    );
  }
}
