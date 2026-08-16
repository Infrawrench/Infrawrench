// `infrawrench apps <resource-id>` — what graphical applications are installed
// on a Linux host, and how to open one.
//
// Listing needs no session and no compositor: the app server is staged in the
// host's RAM, asked for its desktop entries, and deleted again in one SSH exec,
// leaving nothing behind. Launching one needs a canvas, which a terminal does
// not have, so `--launch` hands the resource and the application to the desktop
// app through an `infrawrench://apps` deep link — the same shape the RDP
// command uses.
import { shell } from "electron";
import { listApps } from "@infrawrench/appstream-host";

import {
  CliError,
  listLocalResources,
  loadLocalResourceOutputs,
  type CliContext,
} from "../context";
import type { AppsFlags } from "../args";
import { resolveScopedAccount } from "./listing";
import { getPlugin } from "../../../src/plugins/loader";
import { PROTOCOL } from "../../../env";
import { connectSshChain, endSshChain } from "../../ssh-shell";
import { getArm64GzBinary, getx86_64GzBinary } from "../../iwappd-archive";
import { c, printJson, println, printTable, type Column } from "../output";

interface AppRow {
  id: string;
  name: string;
  comment?: string;
  categories?: string[];
  needsTerminal?: boolean;
}

const binaryForArch = (arch: "x86_64" | "aarch64") =>
  arch === "x86_64" ? getx86_64GzBinary() : getArm64GzBinary();

export async function cmdApps(
  ctx: CliContext,
  resourceId: string,
  flags: AppsFlags,
): Promise<void> {
  if (!resourceId) {
    throw new CliError(
      "Usage: infrawrench apps <resource-id> [--json] [--launch <app-id>] [--key <path>] [--user <name>]",
    );
  }
  // Resource ids embed their account: {accountId}:{typeId}:{externalId}.
  if (!ctx.flags.account) ctx.flags.account = resourceId.split(":")[0]!;

  const launch = typeof flags.launch === "string" ? flags.launch : undefined;
  if (launch) {
    // The window has to render somewhere, and a terminal is not it.
    const url =
      `${PROTOCOL}://apps?resource=${encodeURIComponent(resourceId)}` +
      `&app=${encodeURIComponent(launch)}`;
    await shell.openExternal(url);
    println(c.dim(`opening ${launch} on ${resourceId} in Infrawrench…`));
    return;
  }

  const { account } = await resolveScopedAccount(ctx);
  const typeId = resourceId.split(":")[1];
  const { rows } = await listLocalResources(account, typeId ? { typeId } : {});
  const found = rows.find((row) => row.id === resourceId);
  if (!found) throw new CliError(`Resource ${resourceId} not found in ${account.displayName}.`);

  const plugin = (await getPlugin(found.pluginId))?.plugin;
  const resourceType = plugin?.resourceTypes.find((type) => type.id === found.resourceTypeId);
  const ssh = resourceType?.sshEndpoint;
  if (!ssh) {
    throw new CliError(
      `${found.displayName} (${found.resourceTypeId}) has no SSH endpoint. Applications run over the same connection as the terminal.`,
    );
  }

  const row = await loadLocalResourceOutputs(account, found);
  const host = String(row.outputs[ssh.hostOutputKey] ?? row.fields[ssh.hostOutputKey] ?? "");
  if (!host) {
    throw new CliError(
      `${row.displayName} has no reachable address yet (no ${ssh.hostOutputKey}). It may still be provisioning.`,
    );
  }

  const username =
    (typeof flags.user === "string" ? flags.user : undefined) ??
    (ssh.usernameFieldKey ? String(row.fields[ssh.usernameFieldKey] ?? "") : "") ??
    ssh.defaultUsername ??
    "root";

  const privateKey = await readKeyFlag(flags);
  const { client, intermediates } = await connectSshChain({
    host,
    port: 22,
    username: username || ssh.defaultUsername || "root",
    privateKey,
    cols: 80,
    rows: 24,
  });

  try {
    const apps = (await listApps(client, { binaryForArch, iconSize: 32 })) as AppRow[];

    if (ctx.flags.output === "json") {
      printJson(apps);
      return;
    }
    if (apps.length === 0) {
      println("No graphical applications are installed on this host.");
      println(c.dim("Infrawrench brings the display; the host brings the applications."));
      return;
    }

    const columns: Column<AppRow>[] = [
      { header: "NAME", value: (app) => app.name },
      { header: "ID", value: (app) => app.id },
      { header: "", value: (app) => (app.needsTerminal ? c.dim("terminal") : "") },
    ];
    printTable(apps, columns);
    println("");
    println(c.dim(`infrawrench apps ${resourceId} --launch <id>   open one in Infrawrench`));
  } finally {
    endSshChain(client, intermediates);
  }
}

async function readKeyFlag(flags: AppsFlags): Promise<string> {
  const path = flags.key;
  if (!path) {
    throw new CliError(
      "Applications need an SSH key: pass --key <path to a private key>, and --user if the host's login is not root.",
    );
  }
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new CliError(`Could not read the SSH key at ${path}`);
  }
}
