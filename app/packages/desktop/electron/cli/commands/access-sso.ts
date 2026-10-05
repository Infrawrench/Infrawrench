import { orgFetch, type CliContext } from "../context";
import type { SsoGroupRoleMapping, SsoStatus } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";

function state(s: string): string {
  if (s === "verified" || s === "active") return c.green(s);
  if (s === "failed" || s === "inactive") return c.red(s);
  return c.dim(s);
}

/**
 * `infrawrench access sso`: how the org signs in. Read-only on purpose:
 * turning enforcement on is a lockout-shaped change the settings page guards
 * with checks against the caller's own session, and the identity provider
 * itself is configured in the WorkOS Admin Portal, not here.
 */
export async function cmdAccessSso(ctx: CliContext, orgId: string, orgName: string): Promise<void> {
  const status = await orgFetch<SsoStatus>(orgId, "/sso");
  const mappings = status.configured
    ? (await orgFetch<{ mappings: SsoGroupRoleMapping[] }>(orgId, "/sso/group-mappings")).mappings
    : [];

  if (ctx.flags.output === "json") {
    printJson({ org: orgId, ...status, mappings });
    return;
  }

  println(c.bold(orgName));
  if (!status.planIncluded) println(c.dim("Single sign-on is available on the paid plan."));
  if (!status.configured || !status.settings) {
    println(c.dim("Single sign-on is not set up. Start from Settings → Single Sign-On."));
    return;
  }
  if (status.workosError) println(c.yellow(status.workosError));
  const s = status.settings;
  const owners = new Map(status.owners.map((o) => [o.userId, o.displayName ?? o.email]));
  println(
    `enforcement   ${s.enforceSso ? c.yellow("required for verified domains") : c.dim("off")}`,
  );
  println(
    `break-glass   ${
      s.breakGlassUserIds.length
        ? s.breakGlassUserIds.map((id) => owners.get(id) ?? id).join(", ")
        : c.dim("none")
    }`,
  );
  println(`provisioning  ${s.provisioningEnabled ? "on" : c.dim("off (observe only)")}`);
  println(`your session  ${status.currentSession.replace(/_/g, " ")}`);
  println();

  println(c.bold("Domains"));
  if (status.domains.length === 0) println(c.dim("  none"));
  for (const d of status.domains) println(`  ${d.domain}  ${state(d.state)}`);
  println(c.bold("Identity providers"));
  if (status.connections.length === 0) println(c.dim("  none"));
  for (const x of status.connections) println(`  ${x.name}  ${c.dim(x.type)}  ${state(x.state)}`);
  println(c.bold("Directories"));
  if (status.directories.length === 0) println(c.dim("  none"));
  for (const d of status.directories) println(`  ${d.name}  ${c.dim(d.type)}  ${state(d.state)}`);
  const counts = Object.entries(status.directoryMemberCounts);
  if (counts.length > 0) {
    println(c.dim(`  ${counts.map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ")}`));
  }
  println();

  println(c.bold("Group to role mappings") + c.dim("  (first match wins)"));
  if (mappings.length === 0) {
    println(c.dim("  none"));
    return;
  }
  const columns: Column<SsoGroupRoleMapping>[] = [
    { header: "#", value: (m) => String(mappings.indexOf(m) + 1) },
    { header: "group", value: (m) => m.groupName },
    { header: "role", value: (m) => m.roleName ?? c.dim(m.roleId) },
  ];
  printTable(mappings, columns);
}
