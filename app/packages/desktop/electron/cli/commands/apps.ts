// `infrawrench apps <resource-id>`: what graphical applications are installed
// on a Linux host, and how to open one.
//
// Listing needs no session and no compositor: the app server is staged in the
// host's RAM, asked for its desktop entries, and deleted again in one SSH exec,
// leaving nothing behind. Launching one needs a canvas, which a terminal does
// not have, so `--launch` hands the resource and the application to the desktop
// app through an `infrawrench://apps` deep link: the same shape the RDP
// command uses.
//
// `--check` and `--install` are the same host setup check the launcher shows,
// for the case where the answer is wanted before anyone opens a tab, and for
// the shell script that wants to prepare a fleet of hosts, which is why
// `--check --json` exists and exits non-zero on a host that is not ready.
import { readFile } from "node:fs/promises";
import { shell } from "electron";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  checkHost,
  installRequirements,
  listApps,
  planInstall,
  type HostPreflight,
} from "@infrawrench/appstream-host";

import { listLocalResources, loadLocalResourceOutputs } from "../context";
import { CliExit, CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { resolveScopedAccount } from "./listing";
import { getPlugin } from "../../../src/plugins/loader";
import { PROTOCOL } from "../../../env";
import { acquireSshChain } from "../../ssh-shell";
import { getArm64GzBinary, getx86_64GzBinary } from "../../iwappd-archive";
import { c, println, safe, type Column } from "../output";

/** What the text listing reads of each desktop entry the app server reports. */
const AppRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  needsTerminal: Schema.optional(Schema.Boolean),
});
type AppRow = typeof AppRow.Type;
const decodeApps = Schema.decodeUnknownEffect(Schema.Array(AppRow));

const binaryForArch = (arch: "x86_64" | "aarch64") =>
  arch === "x86_64" ? getx86_64GzBinary() : getArm64GzBinary();

type SshClient = Parameters<typeof checkHost>[0];

const USAGE =
  "Usage: infrawrench apps <resource-id> [--json] [--launch <app-id>] [--check] " +
  "[--install] [--key <path>] [--user <name>]";

/**
 * The key `--key` names, read from disk. Required: an app server runs over
 * the same SSH connection as the terminal, and a terminal session has no
 * stored credential to fall back on.
 */
const readKeyFlag = Effect.fnUntraced(function* (path: string | undefined) {
  if (!path) {
    return yield* new CliFailure({
      message:
        "Applications need an SSH key: pass --key <path to a private key>, and --user if the host's login is not root.",
    });
  }
  return yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => new CliFailure({ message: `Could not read the SSH key at ${path}` }),
  });
});

const printHostSetup = Effect.fnUntraced(function* (preflight: HostPreflight) {
  yield* Print.line(`${preflight.osName}  ${c.dim(preflight.arch)}`);
  yield* Print.line("");
  const width = Math.max(...preflight.requirements.map((req) => req.title.length));
  for (const requirement of preflight.requirements) {
    const mark = requirement.ok
      ? c.green("ok")
      : requirement.severity === "required"
        ? c.red("missing")
        : c.yellow("absent");
    yield* Print.line(`  ${requirement.title.padEnd(width)}  ${mark}`);
    if (!requirement.ok) {
      yield* Print.line(`  ${" ".repeat(width)}  ${c.dim(requirement.summary)}`);
    }
  }
  if (!preflight.staging) {
    yield* Print.line("");
    yield* Print.line(
      c.red(
        "No writable, exec-capable directory to run the app server from: /tmp and /dev/shm are " +
          "unwritable or mounted noexec.",
      ),
    );
  }
  if (preflight.appCount === 0) {
    yield* Print.line("");
    yield* Print.line(c.dim("No graphical applications are installed on this host either."));
  }
});

/**
 * `--check`, and `--install` when asked.
 *
 * Exits 1 on a host that is still not ready afterwards, so a shell loop over
 * a fleet can tell the difference without parsing anything. `--install`
 * prints the commands before running them for the same reason the UI shows
 * them: this installs packages as root on someone's machine.
 */
const runHostSetup = Effect.fnUntraced(function* (client: SshClient, install: boolean) {
  const session = yield* CliSession;
  const json = session.output === "json";
  let { preflight, plan } = yield* Effect.promise(() => checkHost(client));

  if (install && plan?.canInstall) {
    const toRun = plan;
    for (const command of toRun.commands) yield* Print.line(c.dim(`$ ${command}`));
    const outcome = yield* Effect.promise(() =>
      installRequirements(client, toRun, {
        onOutput: (line) => {
          // Held back under --json: the whole point of that flag is one
          // parseable object on stdout. Printed as it arrives.
          if (!json) println(c.dim(line));
        },
      }),
    );
    preflight = outcome.preflight;
    plan = planInstall(preflight);
    if (outcome.failed.length && !json) {
      yield* Print.line("");
      yield* Print.line(c.yellow(`Could not install: ${outcome.failed.join(", ")}`));
    }
  }

  if (json) {
    yield* Print.json({ preflight, plan });
  } else {
    yield* printHostSetup(preflight);
    if (plan) {
      yield* Print.line("");
      if (plan.canInstall && !install) {
        yield* Print.line(c.dim("Run with --install to install these:"));
      } else if (!plan.canInstall) {
        yield* Print.line(
          c.yellow(plan.blockedReason ?? "These must be installed on the host by hand."),
        );
        yield* Print.line(c.dim("Run these on the host:"));
      } else {
        yield* Print.line(c.dim("Still missing. Run these on the host:"));
      }
      for (const command of plan.commands) yield* Print.line(`  ${command}`);
    }
  }
  if (!preflight.ready) return yield* new CliExit({ exitCode: 1 });
});

/** The host's applications, as a table or (`--json`) the app server's own entries. */
const printApps = Effect.fnUntraced(function* (client: SshClient, resourceId: string) {
  const session = yield* CliSession;
  const apps = yield* Effect.promise(() => listApps(client, { binaryForArch, iconSize: 32 }));
  if (session.output === "json") return yield* Print.json(apps);

  const rows = yield* decodeApps(apps).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({
          message: `The host's app server sent an application list this build cannot read: ${error.message}`,
        }),
    ),
  );
  if (rows.length === 0) {
    yield* Print.line("No graphical applications are installed on this host.");
    return yield* Print.line(
      c.dim("Infrawrench brings the display; the host brings the applications."),
    );
  }

  const columns: Column<AppRow>[] = [
    { header: "NAME", value: (app) => safe(app.name) },
    { header: "ID", value: (app) => safe(app.id) },
    { header: "", value: (app) => (app.needsTerminal ? c.dim("terminal") : "") },
  ];
  yield* Print.table(rows, columns);
  yield* Print.line("");
  yield* Print.line(
    c.dim(`infrawrench apps ${resourceId} --launch <id>   open one in Infrawrench`),
  );
});

export const apps = Command.make(
  "apps",
  {
    resource: Argument.String("resource-id").pipe(
      Argument.withDescription("The Linux host: {accountId}:{typeId}:{externalId}"),
      Argument.optional,
    ),
    key: Flag.String("key").pipe(
      Flag.withMetavar("path"),
      Flag.withDescription("Private key to connect with"),
      Flag.optional,
    ),
    user: Flag.String("user").pipe(
      Flag.withMetavar("name"),
      Flag.withDescription("Login name, when the host's is not the resource type's default"),
      Flag.optional,
    ),
    launch: Flag.String("launch").pipe(
      Flag.withMetavar("app-id"),
      Flag.withDescription("Open this application in the desktop app instead of listing"),
      Flag.optional,
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Report what the host is missing before applications can run there"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    install: Flag.Boolean("install").pipe(
      Flag.withDescription("Install what --check finds missing, with the host's package manager"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("apps")(
    function* (input) {
      const session = yield* CliSession;
      const resourceId = Option.getOrElse(input.resource, () => "");
      if (!resourceId) return yield* new CliFailure({ message: USAGE });

      const launch = Option.getOrUndefined(input.launch);
      if (launch) {
        // The window has to render somewhere, and a terminal is not it.
        const url =
          `${PROTOCOL}://apps?resource=${encodeURIComponent(resourceId)}` +
          `&app=${encodeURIComponent(launch)}`;
        yield* Effect.promise(() => shell.openExternal(url));
        return yield* Print.line(c.dim(`opening ${launch} on ${resourceId} in Infrawrench…`));
      }

      // Resource ids embed their account: {accountId}:{typeId}:{externalId}.
      const { account } = yield* resolveScopedAccount(session.account ?? resourceId.split(":")[0]);
      const typeId = resourceId.split(":")[1];
      const { rows } = yield* Effect.promise(() =>
        listLocalResources(account, typeId ? { typeId } : {}),
      );
      const found = rows.find((row) => row.id === resourceId);
      if (!found) {
        return yield* new CliFailure({
          message: `Resource ${resourceId} not found in ${account.displayName}.`,
        });
      }

      const plugin = (yield* Effect.promise(() => getPlugin(found.pluginId)))?.plugin;
      const resourceType = plugin?.resourceTypes.find((type) => type.id === found.resourceTypeId);
      const ssh = resourceType?.sshEndpoint;
      if (!ssh) {
        return yield* new CliFailure({
          message: `${found.displayName} (${found.resourceTypeId}) has no SSH endpoint. Applications run over the same connection as the terminal.`,
        });
      }

      const row = yield* Effect.promise(() => loadLocalResourceOutputs(account, found));
      const host = String(row.outputs[ssh.hostOutputKey] ?? row.fields[ssh.hostOutputKey] ?? "");
      if (!host) {
        return yield* new CliFailure({
          message: `${row.displayName} has no reachable address yet (no ${ssh.hostOutputKey}). It may still be provisioning.`,
        });
      }

      const username =
        Option.getOrUndefined(input.user) ??
        (ssh.usernameFieldKey ? String(row.fields[ssh.usernameFieldKey] ?? "") : "");

      const privateKey = yield* readKeyFlag(Option.getOrUndefined(input.key));
      const { client } = yield* acquireSshChain({
        host,
        port: 22,
        username: username || ssh.defaultUsername || "root",
        privateKey,
      }).pipe(Effect.mapError((error) => new CliFailure({ message: error.message })));
      if (input.check || input.install) return yield* runHostSetup(client, input.install);
      yield* printApps(client, resourceId);
    },
    // The connection is ended (every hop) however the command finishes.
    Effect.scoped,
  ),
).pipe(
  Command.withDescription(
    "Graphical applications installed on a Linux host (--check what it is missing, --install to fix it, --launch <id> to open one)",
  ),
);
