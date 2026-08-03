// `infrawrench rdp <resource-id>` — open a Remote Desktop session to a Windows
// VM. The embedded RDP client lives in the renderer (it needs a canvas + WASM),
// so the CLI resolves and validates the endpoint headlessly, then hands the
// resource off to the desktop app via an `infrawrench://rdp` deep link. With
// --json it prints the resolved endpoint and opens nothing.
import { app, shell } from "electron";
import {
  CliError,
  loadLocalResourceOutputs,
  listLocalResources,
  listCloudResources,
  type CliContext,
} from "../context";
import { resolveScopedAccount } from "./listing";
import { getPlugin } from "../../../src/plugins/loader";
import { PROTOCOL } from "../../../env";
import { c, printJson, println } from "../output";

interface ResolvedRdp {
  resourceId: string;
  accountId: string;
  host: string;
  port: number;
  username: string | null;
}

function gatePasses(
  guard: { fieldKey: string; value: string } | undefined,
  fields: Record<string, unknown>,
): boolean {
  if (!guard) return true;
  return String(fields[guard.fieldKey] ?? "").toLowerCase() === guard.value.toLowerCase();
}

export async function cmdRdp(ctx: CliContext, resourceId: string): Promise<void> {
  if (!resourceId) throw new CliError("Usage: infrawrench rdp <resource-id>");
  // Resource ids embed their account: {accountId}:{typeId}:{externalId}.
  if (!ctx.flags.account) ctx.flags.account = resourceId.split(":")[0]!;
  const { orgId, account } = await resolveScopedAccount(ctx);

  const typeId = resourceId.split(":")[1];
  const rows = orgId
    ? await listCloudResources(orgId, account.id)
    : (await listLocalResources(account, typeId ? { typeId } : {})).rows;
  let row = rows.find((r) => r.id === resourceId);
  if (!row) throw new CliError(`Resource ${resourceId} not found in ${account.displayName}.`);

  const plugin = (await getPlugin(row.pluginId))?.plugin;
  const rt = plugin?.resourceTypes.find((t) => t.id === row!.resourceTypeId);
  const rdp = rt?.rdpEndpoint;
  if (!rdp) {
    throw new CliError(
      `${row.displayName} (${row.resourceTypeId}) does not support RDP. RDP is offered for Windows VMs (EC2, Azure VM, GCE).`,
    );
  }

  // Cloud rows arrive with outputs; local ones resolve on demand.
  if (!orgId) row = await loadLocalResourceOutputs(account, row);
  const fields = row.fields;
  const outputs = row.outputs;

  if (!gatePasses(rdp.runningWhen, fields)) {
    throw new CliError(`${row.displayName} isn't running — start it before connecting via RDP.`);
  }
  if (!gatePasses(rdp.windowsWhen, fields)) {
    throw new CliError(`${row.displayName} isn't a Windows machine — RDP is Windows-only.`);
  }

  const host = String(outputs[rdp.hostOutputKey] ?? fields[rdp.hostOutputKey] ?? "");
  if (!host) {
    throw new CliError(
      `${row.displayName} has no reachable RDP address yet (no ${rdp.hostOutputKey}). It may still be provisioning.`,
    );
  }
  let username: string | null = null;
  if (rdp.usernameFieldKey) {
    const val = String(fields[rdp.usernameFieldKey] ?? "");
    if (val) username = val;
  }
  if (!username && rdp.defaultUsername) username = rdp.defaultUsername;

  const resolved: ResolvedRdp = {
    resourceId: row.id,
    accountId: account.id,
    host,
    port: 3389,
    username,
  };

  if (ctx.flags.output === "json") {
    printJson(resolved);
    return;
  }

  // Handing off to the GUI: the embedded RDP client (canvas + WASM + IPC relay)
  // only exists in the desktop renderer. The deep link launches or focuses the
  // app onto the resource's RDP tab, where the password is entered.
  const deepLink = `${PROTOCOL}://rdp?account=${encodeURIComponent(account.id)}&resource=${encodeURIComponent(row.id)}`;
  println(
    `${c.bold(row.displayName)} ${c.dim(`(${row.resourceTypeId} · ${account.displayName})`)}`,
  );
  println(`  ${c.dim("host")}      ${host}:3389`);
  println(`  ${c.dim("username")}  ${username ?? c.dim("(you'll be prompted)")}`);
  println();
  println(c.dim("Opening the Remote Desktop session in the Infrawrench app…"));
  await shell.openExternal(deepLink);
  app.exit(0);
}
