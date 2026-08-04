// Headless CLI runner. Reached via the bootstrap in electron/index.ts when
// the process was launched with --cli (normally through the `infrawrench`
// shell shim). Runs the full Electron app object — safeStorage needs it for
// the master key — but never opens a window, registers a protocol, or keeps
// the single-instance lock.
import { app } from "electron";
import { wireDbGetter, setDatabaseReadOnly } from "../db";
import { setRequireExistingEncryptionKey, UserFacingError } from "../main-utils";
import { setTokenStoreReadOnly } from "../cloud-tokens";
import { parseCliArgs } from "./args";
import { CliError, type CliContext } from "./context";
import { setColorEnabled, printErr, println, c } from "./output";
import { cmdLogin, cmdLogout, cmdWhoami } from "./commands/auth";
import { cmdOrgs, cmdAccounts, cmdResources, cmdResource } from "./commands/listing";
import { cmdMetrics } from "./commands/metrics";
import { cmdCosts, cmdCostAnomalies } from "./commands/costs";
import { cmdTags, cmdShowback } from "./commands/tags";
import { cmdOrphans } from "./commands/orphans";
import { cmdOversized } from "./commands/oversized";
import { cmdAlerts, cmdAlertEvents } from "./commands/alerts";
import { cmdExpiring } from "./commands/expiring";
import { cmdPosture } from "./commands/posture";
import { cmdChanges } from "./commands/changes";
import { cmdMoment } from "./commands/moment";
import { cmdIncidents } from "./commands/incidents";
import { cmdSchedules } from "./commands/schedules";
import { cmdLeases } from "./commands/leases";
import { cmdGraph } from "./commands/graph";
import { cmdPage, cmdCostsPush } from "./commands/push";
import { cmdCli } from "./commands/cli-install";
import { cmdDeploy } from "./commands/deploy";
import { cmdSshFanout } from "./commands/ssh-fanout";
import { runTui } from "./tui";

const HELP = `infrawrench — manage your infrastructure from the terminal

USAGE
  infrawrench [command] [flags]

COMMANDS
  (none) / tui        interactive dashboard (cute charts included)
  login               sign in to Infrawrench Cloud (browser PKCE)
  logout              sign out
  whoami              show the current session
  orgs                list your organizations
  accounts            list accounts (local + every org by default)
  resources           list an account's resources   --account <id|name>
  resource <id>       show one resource's fields & outputs
  metrics <id>        metric charts for a resource   [--last 6h] [--series cpu] [--local]
  costs               org cost graphs   [--last 30d] [--group-by provider|account|service|region|resource]
  costs --anomalies   days a provider or service spiked past its own baseline   [--days 30]
  costs push          push your own cost rows   --source <name> [--file rows.json | stdin]
  tags                org tag policy, per-account compliance & untagged spend   [--last 30d]
  showback            spend by cost centre via the org's allocation rules   [--last 30d]
  orphans             likely-wasted resources (unattached volumes, idle IPs) with reasons + cost
                      (--local scans this machine's workspace; no cost column without the cloud)
  oversized           machines whose 14-day p95 utilisation sits well under their size, with the
                      recommended smaller size and monthly saving (cloud only)
  alerts              metric threshold alert rules ("CPU > 90% for 15m") with live firing status
  alerts events       recent metric alert firings & recoveries   [--limit 50]
  expiring            certificates, domains, tokens & keys approaching expiry, soonest first
                      (--local scans this machine's workspace)
  posture             security posture findings (public buckets, world-open ingress, unencrypted
                      disks), ranked by severity   (--local scans this machine's workspace)
  changes             what appeared / changed / disappeared across your providers
                      [--last 7d] [--limit 50] [--kind created|updated|deleted] [-a <account>] [--resource <id>]
  incidents           provider status-page incidents overlapping your resources ("is it me or is it them?")
  moment [timestamp]  everything that happened around a timestamp, across every feed
                      [-w/--window 15m|1h|6h]  (omit the timestamp for "around now")
  schedules           sleep/wake schedules: windows, next transitions & projected savings
  leases              resource leases (TTLs): deadlines, auto-delete flags & status
  graph               resource dependency tree   [--resource <id>: what it needs + its blast radius]
  ssh-fanout <cmd>    run one command across many SSH hosts; identical output is collapsed and
                      outliers are diffed against the majority   [--list] [--hosts <q>] [--plugin <id>]
                      [--tag k:v] [--key <id|name>] [--user <name>] [--snippet <name>] [-y]
                      (put -- before a remote command with flags of its own:
                      infrawrench ssh-fanout -y -- uptime -p)
  ssh-fanout snippets the organization's saved fan-out commands
  page <message>      alert the org's on-call transports   --source <name> [--key k] [--voice]
  page clear          drop a page key's cooldown after a recovery   --source <name> [--key k]
  deploy              build & ship this project via its Infrafile   [-e <env>] [--plan]
                      (--org/--local scope which accounts the Infrafile sees)
  deploy typings      print Infrafile.d.ts for your editor
  deploy log          recent deploys for the organization (--local: this machine's)   [-e <env>]
  deploy rollback     ship a previous deploy's image again   [-e <env>] [--to-run <id>] [--delete-created]
  deploy outputs      print the last successful deploy's infra.output(...) value   [-e <env>]
  deploy status       check the resources the local ledger says exist   [-e <env>]
  deploy destroy      run the Infrafile's destroy() stage — tear the env down   [-e <env>] [--created]
  cli install         install this shell command (also: uninstall, status)
  help                show this help

FLAGS
  --org <id|name>     scope to one organization
  --local             scope to the local (desktop) workspace
  -a, --account <x>   account id or name for resource commands
  --json / --text     output mode (default: text)
  --last / --from / --to   time range for metrics, costs & changes
  --days <n>          whole-day window for costs --anomalies and changes
  --limit <n>         row cap for changes (max 200)
  --kind <k>          changes filter: created | updated | deleted
  --resource <id>     focus one resource (graph) / filter to it (changes)
  -w, --window <d>    moment half-window, e.g. 30m, 1h, 6h (± around the timestamp)
  --type <typeId>     filter resources by resource type
  --source <name>     who is pushing (required by page and costs push)
  --key <k>           page throttle key   --title <t>   --cooldown <min>   --voice
  -f, --file <path>   JSON rows for costs push (stdin when omitted)
  -e, --env <name>    environment to deploy (optional when the Infrafile has one)
  --plan              deploy: show the plan and Dockerfile, build nothing
  --set <key=value>   deploy: answer a select() without prompting (repeatable)
  --to-run <runId>    deploy rollback: which run to go back to
  --delete-created    deploy rollback: also delete resources newer runs created
  --created           deploy destroy: delete what the local ledger says the env created (needs -e)
  --list              ssh-fanout: show the selectable hosts instead of running
  --hosts <q>         ssh-fanout: match host name / address / tag
  --plugin <id>       ssh-fanout: restrict to one provider
  --tag <key:value>   ssh-fanout: restrict to hosts carrying this tag
  --key <id|name>     ssh-fanout: org SSH key for VM hosts (also: page throttle key)
  --user <name>       ssh-fanout: username override for VM hosts
  --snippet <name>    ssh-fanout: run a saved command instead of a literal one
  -y, --yes           ssh-fanout: skip the "Run on N hosts?" confirmation
  --concurrency <n>   ssh-fanout: simultaneous connections (default 8, max 16)
  --no-color          disable ANSI colors
  -v, --version       app version

The CLI shares the desktop app's data: the same local accounts, the same
cloud session, the same organizations. Sign in once, use both.`;

/**
 * Make an Electron process behave like a terminal program. Three things the
 * GUI never has to think about:
 *
 * - Closing the terminal does not kill an Electron app: Chromium swallows
 *   SIGHUP's default disposition, so an orphaned CLI keeps running headless
 *   until its next stdout write hits the dead pty and throws `write EIO`.
 *   Exit on SIGHUP like every other CLI instead.
 * - stdout/stderr can die before we do (`| head -1` closes the pipe → EPIPE;
 *   a closed terminal → EIO). Both mean nobody is reading — exit quietly.
 * - Anything else uncaught must print to the terminal and exit non-zero.
 *   Without a listener, Electron answers uncaught exceptions with a GUI
 *   error dialog, which is bizarre from a shell.
 */
function installTerminalGuards(): void {
  process.on("SIGHUP", () => app.exit(129));

  const onStreamError = (err: NodeJS.ErrnoException): void => {
    // An `error` listener also stops the stream error from re-throwing as an
    // uncaught exception, which would try to write to the same dead stream.
    app.exit(err.code === "EPIPE" || err.code === "EIO" ? 0 : 1);
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);

  process.on("uncaughtException", (err) => {
    try {
      printErr(c.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    } catch {
      // stderr itself is what broke — nothing left to say it with.
    }
    app.exit(1);
  });
}

/**
 * True when the GUI already runs — probe the single-instance lock.
 *
 * MUST be called after `app.whenReady()`. Losing the lock *before* the ready
 * event leaves the app permanently un-ready: Electron gates startup for a
 * second instance because it expects the loser to `app.quit()`, so
 * `whenReady()` never resolves and the CLI hangs with no output at all.
 * Probing after ready returns the same answer and costs nothing.
 */
function detectGuiRunning(): boolean {
  const acquired = app.requestSingleInstanceLock();
  if (acquired) {
    // We only probed; give the lock back so a GUI launched later can have it.
    app.releaseSingleInstanceLock();
    return false;
  }
  return true;
}

export async function runCli(): Promise<void> {
  installTerminalGuards();
  // Terminal process: no GPU, no dock icon, as little Chromium as possible.
  app.commandLine.appendSwitch("disable-gpu");
  if (process.platform === "darwin") app.dock?.hide();

  const argv = process.argv.slice(process.argv.indexOf("--cli") + 1);

  let exitCode = 0;
  try {
    const parsed = parseCliArgs(argv);
    setColorEnabled(parsed.flags.color && process.stdout.isTTY === true && !process.env.NO_COLOR);

    if (parsed.version) {
      println(app.getVersion());
      app.exit(0);
      return;
    }

    const [command, ...rest] = parsed.positionals;

    if (parsed.flags.help || command === "help") {
      println(HELP);
      app.exit(0);
      return;
    }

    // Order is load-bearing — see detectGuiRunning(). Ready first, probe second.
    await app.whenReady();
    const guiRunning = detectGuiRunning();

    wireDbGetter();
    setDatabaseReadOnly(guiRunning);
    setTokenStoreReadOnly(guiRunning);
    // The GUI owns first-run key creation. A terminal session that can't reach
    // the keychain must fail loudly rather than mint a key that orphans every
    // stored credential.
    setRequireExistingEncryptionKey(true);

    const ctx: CliContext = { flags: parsed.flags, positionals: parsed.positionals, guiRunning };

    switch (command) {
      case undefined:
      case "tui":
        if (!process.stdout.isTTY) {
          println(HELP);
          break;
        }
        await runTui(ctx);
        break;
      case "login":
        await cmdLogin(ctx);
        break;
      case "logout":
        await cmdLogout(ctx);
        break;
      case "whoami":
        await cmdWhoami(ctx);
        break;
      case "orgs":
        await cmdOrgs(ctx);
        break;
      case "accounts":
        await cmdAccounts(ctx);
        break;
      case "resources":
        await cmdResources(ctx, parsed.range.type);
        break;
      case "resource":
        await cmdResource(ctx, rest[0] ?? "");
        break;
      case "metrics":
        await cmdMetrics(ctx, rest[0] ?? "", parsed.range);
        break;
      case "costs":
        if (rest[0] === "push") {
          await cmdCostsPush(ctx, parsed.push);
          break;
        }
        if (parsed.anomalies) {
          await cmdCostAnomalies(ctx, parsed.range);
          break;
        }
        await cmdCosts(ctx, parsed.range);
        break;
      case "tags":
        await cmdTags(ctx, parsed.range);
        break;
      case "showback":
        await cmdShowback(ctx, parsed.range);
        break;
      case "orphans":
        await cmdOrphans(ctx);
        break;
      case "oversized":
        await cmdOversized(ctx);
        break;
      case "alerts":
        if (rest[0] === "events") {
          await cmdAlertEvents(ctx, parsed.range.limit);
          break;
        }
        await cmdAlerts(ctx);
        break;
      case "expiring":
        await cmdExpiring(ctx);
        break;
      case "posture":
        await cmdPosture(ctx);
        break;
      case "changes":
        await cmdChanges(ctx, parsed.range);
        break;
      case "incidents":
        await cmdIncidents(ctx);
        break;
      case "moment":
        await cmdMoment(ctx, parsed.range);
        break;
      case "schedules":
        await cmdSchedules(ctx);
        break;
      case "leases":
        await cmdLeases(ctx);
        break;
      case "graph":
        // `infrawrench graph <resource-id>` is the same as --resource; a
        // resource id is the only positional this command could take.
        await cmdGraph(ctx, rest[0] ? { ...parsed.range, resource: rest[0] } : parsed.range);
        break;
      case "page":
        await cmdPage(ctx, rest, parsed.push);
        break;
      case "deploy":
        await cmdDeploy(ctx, parsed.deploy);
        break;
      case "ssh-fanout":
        await cmdSshFanout(ctx, rest, parsed.fanout);
        break;
      case "cli":
        await cmdCli(ctx, rest[0]);
        break;
      default:
        printErr(`Unknown command "${command}". Run \`infrawrench help\`.`);
        exitCode = 2;
    }
  } catch (e) {
    // A stack trace is for a bug in here, not for a typo'd flag or a locked
    // keychain — those print as a single line.
    if (e instanceof CliError || e instanceof UserFacingError) {
      printErr(c.red(e.message));
      exitCode = e instanceof CliError ? e.exitCode : 1;
    } else {
      printErr(c.red(e instanceof Error ? (e.stack ?? e.message) : String(e)));
      exitCode = 1;
    }
  }

  app.exit(exitCode);
}
