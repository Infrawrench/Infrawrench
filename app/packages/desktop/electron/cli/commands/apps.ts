// `infrawrench apps <resource-id>` — what graphical applications are installed
// on a Linux host, and how to open one.
//
// Listing needs no session and no compositor: the app server is staged in the
// host's RAM, asked for its desktop entries, and deleted again in one SSH exec,
// leaving nothing behind. Launching one needs a canvas, which a terminal does
// not have, so `--launch` hands the resource and the application to the desktop
// app through an `infrawrench://apps` deep link — the same shape the RDP
// command uses.
//
// `--check` and `--install` are the same host setup check the launcher shows,
// for the case where the answer is wanted before anyone opens a tab — and for
// the shell script that wants to prepare a fleet of hosts, which is why
// `--check --json` exists and exits non-zero on a host that is not ready.
import { shell } from "electron";
import {
  checkHost,
  installRequirements,
  listApps,
  planInstall,
  type HostPreflight,
} from "@infrawrench/appstream-host";

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
      "Usage: infrawrench apps <resource-id> [--json] [--launch <app-id>] [--check] " +
        "[--install] [--key <path>] [--user <name>]",
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
    if (flags.check || flags.install) {
      await runHostSetup(ctx, client, flags.install);
      return;
    }

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

/**
 * `--check`, and `--install` when asked.
 *
 * Exits non-zero on a host that is still not ready afterwards, so a shell loop
 * over a fleet can tell the difference without parsing anything. `--install`
 * prints the commands before running them for the same reason the UI shows
 * them: this installs packages as root on someone's machine.
 */
async function runHostSetup(
  ctx: CliContext,
  client: Parameters<typeof checkHost>[0],
  install: boolean,
): Promise<void> {
  let { preflight, plan } = await checkHost(client);

  if (install && plan?.canInstall) {
    for (const command of plan.commands) println(c.dim(`$ ${command}`));
    const outcome = await installRequirements(client, plan, {
      onOutput: (line) => {
        // Held back under --json: the whole point of that flag is one parseable
        // object on stdout.
        if (ctx.flags.output !== "json") println(c.dim(line));
      },
    });
    preflight = outcome.preflight;
    plan = planInstall(preflight);
    if (outcome.failed.length && ctx.flags.output !== "json") {
      println("");
      println(c.yellow(`Could not install: ${outcome.failed.join(", ")}`));
    }
  }

  if (ctx.flags.output === "json") {
    printJson({ preflight, plan });
    if (!preflight.ready) process.exitCode = 1;
    return;
  }

  printHostSetup(preflight);
  if (plan) {
    println("");
    if (plan.canInstall && !install) {
      println(c.dim("Run with --install to install these:"));
    } else if (!plan.canInstall) {
      println(c.yellow(plan.blockedReason ?? "These must be installed on the host by hand."));
      println(c.dim("Run these on the host:"));
    } else {
      println(c.dim("Still missing. Run these on the host:"));
    }
    for (const command of plan.commands) println(`  ${command}`);
  }
  if (!preflight.ready) process.exitCode = 1;
}

function printHostSetup(preflight: HostPreflight): void {
  println(`${preflight.osName}  ${c.dim(preflight.arch)}`);
  println("");
  const width = Math.max(...preflight.requirements.map((req) => req.title.length));
  for (const requirement of preflight.requirements) {
    const mark = requirement.ok
      ? c.green("ok")
      : requirement.severity === "required"
        ? c.red("missing")
        : c.yellow("absent");
    println(`  ${requirement.title.padEnd(width)}  ${mark}`);
    if (!requirement.ok) println(`  ${" ".repeat(width)}  ${c.dim(requirement.summary)}`);
  }
  if (!preflight.staging) {
    println("");
    println(
      c.red(
        "No writable, exec-capable directory to run the app server from — /tmp and /dev/shm are " +
          "unwritable or mounted noexec. No package fixes this.",
      ),
    );
  }
  if (preflight.appCount === 0) {
    println("");
    println(c.dim("No graphical applications are installed on this host either."));
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
