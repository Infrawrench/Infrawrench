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
import { cmdCosts } from "./commands/costs";
import { cmdPage, cmdCostsPush } from "./commands/push";
import { cmdCli } from "./commands/cli-install";
import { cmdDeploy } from "./commands/deploy";
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
  metrics <id>        metric charts for a cloud resource   [--last 6h] [--series cpu]
  costs               org cost graphs   [--last 30d] [--group-by provider|account|service|region|resource]
  costs push          push your own cost rows   --source <name> [--file rows.json | stdin]
  page <message>      alert the org's on-call transports   --source <name> [--key k] [--voice]
  page clear          drop a page key's cooldown after a recovery   --source <name> [--key k]
  deploy              build & ship this project via its Infrafile   [-e <env>] [--plan]
  deploy typings      print Infrafile.d.ts for your editor
  deploy log          recent deploys for the organization (--local: this machine's)   [-e <env>]
  deploy rollback     ship a previous deploy's image again   [-e <env>] [--to-run <id>]
  cli install         install this shell command (also: uninstall, status)
  help                show this help

FLAGS
  --org <id|name>     scope to one organization
  --local             scope to the local (desktop) workspace
  -a, --account <x>   account id or name for resource commands
  --json / --text     output mode (default: text)
  --last / --from / --to   time range for metrics & costs
  --type <typeId>     filter resources by resource type
  --source <name>     who is pushing (required by page and costs push)
  --key <k>           page throttle key   --title <t>   --cooldown <min>   --voice
  -f, --file <path>   JSON rows for costs push (stdin when omitted)
  -e, --env <name>    environment to deploy (optional when the Infrafile has one)
  --plan              deploy: show the plan and Dockerfile, build nothing
  --set <key=value>   deploy: answer a select() without prompting (repeatable)
  --to-run <runId>    deploy rollback: which run to go back to
  --no-color          disable ANSI colors
  -v, --version       app version

The CLI shares the desktop app's data: the same local accounts, the same
cloud session, the same organizations. Sign in once, use both.`;

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
        await cmdCosts(ctx, parsed.range);
        break;
      case "page":
        await cmdPage(ctx, rest, parsed.push);
        break;
      case "deploy":
        await cmdDeploy(ctx, parsed.deploy);
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
