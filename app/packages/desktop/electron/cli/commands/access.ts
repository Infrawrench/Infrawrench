import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { AccessRequest } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";

/** "45m" / "2h" — kept local so the CLI pulls nothing UI-shaped. */
function duration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** "in 24m" / "24m ago" — the countdown cell. */
function countdown(at: string | null): string {
  if (!at) return c.dim("—");
  const ms = Date.parse(at) - Date.now();
  if (Number.isNaN(ms)) return c.dim("—");
  const abs = Math.abs(ms);
  const label =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)}d`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.max(1, Math.round(abs / 60_000))}m`;
  return ms >= 0 ? `in ${label}` : c.dim(`${label} ago`);
}

function statusCell(request: AccessRequest): string {
  if (request.active) return c.yellow("LIVE");
  switch (request.status) {
    case "pending":
      return c.cyan("waiting");
    case "approved":
      return c.dim(request.revokedAt ? "ended early" : "lapsed");
    case "denied":
      return c.red("denied");
    case "expired":
      return c.dim("expired");
  }
}

/**
 * `infrawrench access` — break-glass requests and live elevations.
 *
 * Read-only by design. Raising a request needs a reason someone will read and
 * a permission picker that cannot drift from the server's catalog, and both of
 * those belong on a screen; deciding one is a judgement call that should
 * involve looking at what is being asked for. What the CLI is genuinely good
 * at is the question an on-call engineer actually types at 3am — "who is
 * elevated right now" — so that is what it answers.
 */
export async function cmdAccess(ctx: CliContext, rest: string[]): Promise<void> {
  const org = await resolveOrg(ctx);
  const sub = rest[0];
  if (sub !== undefined && sub !== "list" && sub !== "active") {
    throw new CliError(`Unknown subcommand "${sub}". Try: access, access active`);
  }

  const query = sub === "active" ? "?active=1" : "";
  const requests = await orgFetch<AccessRequest[]>(org.id, `/access-requests${query}`);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, requests });
    return;
  }

  if (requests.length === 0) {
    println(
      c.dim(
        sub === "active"
          ? "Nobody is holding elevated access right now."
          : "No break-glass requests. Ask for one from Settings → Break-glass Access.",
      ),
    );
    return;
  }

  const live = requests.filter((r) => r.active).length;
  const waiting = requests.filter((r) => r.status === "pending").length;
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${live} live elevation${live === 1 ? "" : "s"}, ${waiting} waiting for a decision`,
    )}`,
  );
  println();

  const columns: Column<AccessRequest>[] = [
    { header: "who", value: (r) => r.userName ?? c.dim("unknown") },
    { header: "permissions", value: (r) => r.permissions.join(", ") },
    { header: "for", value: (r) => duration(r.durationMinutes) },
    { header: "status", value: (r) => statusCell(r) },
    {
      header: "clock",
      value: (r) =>
        countdown(r.active ? r.grantExpiresAt : r.status === "pending" ? r.expiresAt : null),
    },
    { header: "reason", value: (r) => c.dim(r.reason) },
  ];
  printTable(requests, columns);

  if (live > 0) {
    println();
    println(
      c.dim(
        "Live elevations lapse on their own. End one early from Settings → Break-glass Access.",
      ),
    );
  }
}
