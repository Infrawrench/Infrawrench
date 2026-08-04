import { orgFetch, resolveOrg, type CliContext } from "../context";
import type { ResourceLease, ResourceLeaseListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";

/** "in 3d" / "in 5h" / "2d overdue" — the lease countdown cell. */
function expiresSummary(lease: ResourceLease): string {
  const ms = Date.parse(lease.expiresAt) - Date.now();
  const abs = Math.abs(ms);
  const label =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)}d`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.max(1, Math.round(abs / 60_000))}m`;
  const when = lease.expiresAt.replace("T", " ").slice(0, 16);
  if (lease.status !== "active") return c.dim(`${when}Z`);
  return ms >= 0 ? `in ${label} (${when}Z)` : c.red(`${label} overdue (${when}Z)`);
}

function statusSummary(lease: ResourceLease): string {
  switch (lease.status) {
    case "active":
      if (lease.autoDelete && lease.finalWarningAt) return c.yellow("final warning sent");
      if (lease.autoDelete && lease.firstWarningAt) return c.yellow("first warning sent");
      return c.green("active");
    case "deleted":
      return c.dim("deleted");
    case "canceled":
      return c.dim("canceled");
    case "failed":
      return c.red(`failed${lease.lastError ? `: ${lease.lastError}` : ""}`);
  }
}

/**
 * `infrawrench leases` — every resource lease in the org: deadline,
 * auto-delete flag and status. (The `expiring` command already shows lease
 * deadlines inside the expiry radar; this is the lease-management view.)
 */
export async function cmdLeases(ctx: CliContext): Promise<void> {
  const org = await resolveOrg(ctx);
  const response = await orgFetch<ResourceLeaseListResponse>(org.id, "/leases");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...response });
    return;
  }

  if (response.leases.length === 0) {
    println(
      c.dim(
        "No resource leases. Set one from a resource's Lease tab (web or desktop) to put an expiry on it — optionally auto-deleting it when the lease runs out.",
      ),
    );
    return;
  }

  const active = response.leases.filter((l) => l.status === "active").length;
  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${response.leases.length} lease${response.leases.length === 1 ? "" : "s"} (${active} active)`,
    )}`,
  );
  println();

  const columns: Column<ResourceLease>[] = [
    { header: "resource", value: (l) => l.resourceName },
    { header: "account", value: (l) => c.dim(l.accountName) },
    { header: "expires", value: (l) => expiresSummary(l) },
    { header: "auto-delete", value: (l) => (l.autoDelete ? c.red("yes") : c.dim("no")) },
    { header: "status", value: (l) => statusSummary(l) },
    { header: "note", value: (l) => (l.note ? c.dim(l.note) : c.dim("—")) },
  ];
  printTable(response.leases, columns);
  println();
  println(
    c.dim(
      "Active leases also appear in `infrawrench expiring`. Auto-deletes are announced twice before they fire and pause during change freezes.",
    ),
  );
}
