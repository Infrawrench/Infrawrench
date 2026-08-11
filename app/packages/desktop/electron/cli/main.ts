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
import { cmdExport } from "./commands/export";
import { cmdEstimate } from "./commands/estimate";
import { cmdCosts, cmdCostAnomalies, cmdCostAlerts } from "./commands/costs";
import { cmdBusinessMetrics, cmdUnitCosts } from "./commands/unit-costs";
import { cmdScenarios, cmdApplyScenario } from "./commands/scenarios";
import { cmdReports, cmdRunReport, cmdSendReport } from "./commands/reports";
import { cmdExports, cmdRunExport } from "./commands/exports";
import { cmdTags, cmdShowback } from "./commands/tags";
import { cmdBillingRules, cmdBillingRule } from "./commands/billing-rules";
import { cmdInvoice, cmdInvoiceCustomers, cmdInvoices } from "./commands/invoices";
import { cmdOrphans } from "./commands/orphans";
import { cmdOversized } from "./commands/oversized";
import { cmdAlerts, cmdAlertEvents } from "./commands/alerts";
import { cmdRouting, cmdRoutingQueue } from "./commands/routing";
import { cmdExpiring } from "./commands/expiring";
import { cmdPosture, cmdPostureDismiss, cmdPostureRestore } from "./commands/posture";
import { cmdDns } from "./commands/dns";
import { cmdChanges } from "./commands/changes";
import { cmdDiff } from "./commands/diff";
import { cmdMoment } from "./commands/moment";
import { cmdIncidents } from "./commands/incidents";
import { cmdSchedules } from "./commands/schedules";
import { cmdLeases } from "./commands/leases";
import { cmdRecordings } from "./commands/recordings";
import { cmdAccess } from "./commands/access";
import { cmdHygiene } from "./commands/hygiene";
import { cmdCredits } from "./commands/credits";
import { cmdCommitments } from "./commands/commitments";
import { cmdProbes } from "./commands/probes";
import { cmdDeclaredIncidents } from "./commands/declared-incidents";
import { cmdStatusPages } from "./commands/status-pages";
import { cmdOwnership } from "./commands/ownership";
import { cmdGraph } from "./commands/graph";
import { cmdBlastRadius } from "./commands/blast-radius";
import { cmdPage, cmdCostsPush } from "./commands/push";
import { cmdCli } from "./commands/cli-install";
import { cmdDeploy } from "./commands/deploy";
import { cmdSshFanout } from "./commands/ssh-fanout";
import { cmdConfig } from "./commands/config";
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
  export              eject an account's inventory as Terraform HCL   --account <id|name> [--format terraform]
  estimate <id|name>  what a resource costs per month at list price, itemized (cloud only;
                      full id, or a name/external-id with --account)
  costs               org cost graphs   [--last 30d] [--group-by provider|account|service|region|resource|charge_type|commitment]
                      [--basis cash|amortized] [--charge-type usage|credit|tax|… (repeatable)]
                      [--currency USD  convert to your org's display currency at its stated rates]
                      [--where "provider = 'aws' AND tag['env'] != 'dev'"  filter, as text]
                      [--filter <name|id>  a saved cost filter, resolved server-side; ANDs with --where]
  costs --anomalies   days a provider or service spiked past its own baseline   [--days 30]
  costs --alerts      change-based cost alerts + recent firings ("spend moved >X% vs the
                      prior period" — distinct from budgets and anomalies)   [--limit 20]
  costs push          push your own cost rows   --source <name> [--file rows.json | stdin]
  reports             the org's saved cost reports (named cost graphs)
  reports <name|id>   run one saved report and chart it
  reports send <n|id> deliver a report to its schedules (Slack/Teams/email) right now
  exports             scheduled cost exports (raw rows → warehouse/object store), with the
                      last run's status and error
  exports run <n|id>  run one export now and list the objects it wrote
  tags                org tag policy, per-account compliance & untagged spend   [--last 30d]
  showback            spend by cost centre via the org's allocation rules, as an indented
                      tree — a parent's bar is its subtree total   [--last 30d]
  billing-rules       the org's own adjustments to collected spend (markups, discounts, fixed
                      charges, reallocations) — why a report may not match the invoice
  billing-rules <n>   one rule in full, by name or id
  invoices            invoices raised against managed accounts (customers), newest first — a
                      draft's total is not computed in the list, an issued one is frozen
  invoices customers  the managed accounts themselves: billing currency, cost basis and the
                      cost centres whose spend is theirs
  invoices <n|id>     one invoice in full, by number, id or customer — lines, the adjustments
                      applied, the rate used and the day it was read
  unit-costs          the org's business metrics (the denominators unit costs divide by) and
                      how well each one is being reported
  scenarios           scenario models — known future cost the trend can't see (a purchase, a
                      new team, a migration)
  scenarios <name>    apply one to the forecast; prints the unadjusted trend alongside, always
                      [--last 30d]
  unit-costs <key>    cost per unit of a business metric over time — a period with no reported
                      value prints as "—", never as 0   [--last 30d]
                      [--group-by daily|weekly|monthly|cumulative] [--basis cash|amortized]
                      [--currency USD] [--where "…"] [--margin  revenue metrics only]
  orphans             likely-wasted resources (unattached volumes, idle IPs) with reasons + cost
                      (--local scans this machine's workspace; no cost column without the cloud)
  oversized           machines whose 14-day p95 utilisation sits well under their size, with the
                      recommended smaller size and monthly saving (cloud only)
  alerts              metric threshold alert rules ("CPU > 90% for 15m") with live firing status
  alerts events       recent metric alert firings & recoveries   [--limit 50]
  routing             alert routing rules, in evaluation order
  routing queue       alerts held for quiet hours or awaiting ack [--limit 50]
  expiring            certificates, domains, tokens & keys approaching expiry, soonest first
                      (--local scans this machine's workspace)
  posture             security posture findings (public buckets, world-open ingress, unencrypted
                      disks), ranked by severity   (--local scans this machine's workspace)
  posture dismiss     accept a finding as a known risk — it leaves the list and the daily alerts
                      <resourceId> <ruleId> [--reason <text>]   (ids from posture --json)
  posture restore     put a dismissed finding back   <resourceId> <ruleId>
  dns                 every DNS zone & record across your providers, with dangling targets
                      (subdomain-takeover risks) flagged   (--local scans this machine's workspace)
  changes             what appeared / changed / disappeared across your providers
                      [--last 7d] [--limit 50] [--kind created|updated|deleted] [-a <account>] [--resource <id>]
  diff                two accounts of one provider compared: resource types present in one and
                      not the other, count deltas & field divergence   -a <account> -b <account>
                      [--type <typeId>] [--all]  (--local compares two local accounts)
  incidents           provider status-page incidents overlapping your resources ("is it me or is it them?")
  moment [timestamp]  everything that happened around a timestamp, across every feed
                      [-w/--window 15m|1h|6h]  (omit the timestamp for "around now")
  schedules           sleep/wake schedules: windows, next transitions & projected savings
  leases              resource leases (TTLs): deadlines, auto-delete flags & status
  access              break-glass requests & live permission elevations
  credits             prepaid balances with burn rate & runway ("6 days left")
  commitments         reserved instances, savings plans & committed-use discounts:
                      coverage, utilization & the savings planner's recommendations
  hygiene             unused API keys, unreferenced SSH keys & unexercised
                      write permissions   [--days 30|90|180|365]
  access active       only the elevations in force right now
  recordings          recorded SSH sessions: who connected, to what, for how long
  recordings get <id> print the session's asciicast   [-f/--file <path>]
                      (pipe it: infrawrench recordings get <id> | asciinema play -)
  probes [id|name]    synthetic uptime/latency checks probed from outside your infra, with
                      live status, 24h uptime & last latency (give an id/name for its chart)
  status-pages [name] public status pages built from your probes: what each publishes and the
                      URL it is live at (give a name/id for its components)
  declared-incidents  incidents YOU declared (incident mode): severity, status, duration & whether
       [id|title]     anything the declaration asked for failed (give an id/title for its joined
                      timeline). "incidents" above is the other kind — the providers'.
  ownership [query]   who owns each resource, what it's for & its ticket (a resource absent
                      from this list is unowned; see orphans for the wasted ones)
  graph               resource dependency tree   [--resource <id>: what it needs + its blast radius]
  blast-radius <id>   what breaks if a resource is deleted: dependants, the dashboards/probes/
                      alerts/leases that point at it, what talks to it, and what wasn't checked
  ssh-fanout <cmd>    run one command across many SSH hosts; identical output is collapsed and
                      outliers are diffed against the majority   [--list] [--hosts <q>] [--plugin <id>]
                      [--tag k:v] [--key <id|name>] [--user <name>] [--snippet <name>] [-y]
                      (put -- before a remote command with flags of its own:
                      infrawrench ssh-fanout -y -- uptime -p)
  ssh-fanout snippets the organization's saved fan-out commands
  config export       the org's dashboards, workflows, budgets, graphs, alert rules & policies
                      as one JSON document   [--out file] [--sections a,b]  (stdout when no --out)
  config plan         what applying a document would change, without changing it   [-f file] [--prune]
  config apply        apply a document   [-f file] [--prune] [--sections a,b] [-y]
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
  -b, --against <x>   diff: the second account (-a supplies the first)
  --all               diff: compare ids, addresses & timestamps too
  --resource <id>     focus one resource (graph) / filter to it (changes)
  -w, --window <d>    moment half-window, e.g. 30m, 1h, 6h (± around the timestamp)
  --type <typeId>     filter resources by resource type
  --format <fmt>      export format (default: terraform)
  --reason <text>     posture dismiss: why the finding is an accepted risk
  --where <query>     costs: filter in the cost query language — terms joined by AND, each
                      dimension = 'v' | != 'v' | IN ('a','b') | NOT IN ('a','b'), plus
                      tag['key'] = 'v'. Dimensions: provider, account, service, region,
                      resource, tag, charge_type, commitment. OR is not supported (the filter
                      is a conjunction) — use IN ('a','b') for several values of one dimension
  --filter <name|id>  costs: apply a saved cost filter by reference — resolved on the server
                      at query time, so it always means what it means everywhere else; combines
                      with --where by AND
  --margin            unit-costs: draw (revenue − cost) ÷ revenue instead of cost per unit.
                      Only for a metric declared revenue-shaped — the server refuses it for a
                      count metric rather than returning a plausible wrong number
  --source <name>     who is pushing (required by page and costs push)
  --key <k>           page throttle key   --title <t>   --cooldown <min>   --voice
  -f, --file <path>   JSON rows for costs push / config document (stdin when omitted)
  --out <path>        config export: write the document here instead of stdout
  --sections <a,b>    config: limit to these sections (budgets, workflows, dashboards, …)
  --prune             config apply: also delete what the document doesn't name
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
  -y, --yes           skip the confirmation (ssh-fanout's "Run on N hosts?", config apply's plan)
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
      case "export":
        await cmdExport(ctx, parsed.exportFlags.format);
        break;
      case "estimate":
        await cmdEstimate(ctx, rest[0] ?? "");
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
        if (parsed.alerts) {
          await cmdCostAlerts(ctx, parsed.range);
          break;
        }
        await cmdCosts(ctx, parsed.range);
        break;
      case "reports":
        // `reports send <name|id>` delivers one to its schedules — behind an
        // explicit verb like `exports run`, because it posts into channels
        // and inboxes. (A report literally named "send" stays reachable by
        // id.) Otherwise `infrawrench reports <name|id>` runs one and bare
        // `reports` lists them — a name is the point of the object, so the
        // positional accepts either.
        if (rest[0] === "send") {
          await cmdSendReport(ctx, rest.slice(1).join(" "));
          break;
        }
        if (rest.length > 0) {
          await cmdRunReport(ctx, rest.join(" "));
          break;
        }
        await cmdReports(ctx);
        break;
      case "exports":
        // `exports run <name|id>` forces one; bare `exports` lists them with
        // the last run's status. Unlike `reports`, running is behind an
        // explicit verb: this one writes to somebody's bucket.
        if (rest[0] === "run") {
          await cmdRunExport(ctx, rest.slice(1).join(" "));
          break;
        }
        await cmdExports(ctx);
        break;
      case "tags":
        await cmdTags(ctx, parsed.range);
        break;
      case "showback":
        await cmdShowback(ctx, parsed.range);
        break;
      // Read-only on purpose. Writing a markup changes every figure the org
      // reports about itself and rides `org:settings:write`; that is a
      // considered act with a form and an audit entry behind it, not something
      // to make one flag away in a shell.
      case "billing-rules":
        if (rest.length > 0) {
          await cmdBillingRule(ctx, rest.join(" "));
          break;
        }
        await cmdBillingRules(ctx);
        break;
      // Read-only on purpose. Approving an invoice freezes the figures a
      // customer will be sent and sending one states that they have them;
      // both ride `invoices:issue` and carry an audit entry naming a person,
      // which is not a thing to make one flag away in a shell.
      case "invoices":
        if (rest[0] === "customers") {
          await cmdInvoiceCustomers(ctx);
          break;
        }
        if (rest.length > 0) {
          await cmdInvoice(ctx, rest.join(" "));
          break;
        }
        await cmdInvoices(ctx);
        break;
      // Not `metrics` — that verb already charts a resource's provider metrics,
      // and taking it would break a shipped command. With no argument this
      // lists the org's business metrics; with a key it draws the ratio.
      case "unit-costs":
        if (rest[0]) {
          await cmdUnitCosts(ctx, rest.join(" "), parsed.range, parsed.margin);
          break;
        }
        await cmdBusinessMetrics(ctx);
        break;
      // Bare `scenarios` lists the org's models; with a name or id it applies
      // one to the forecast and prints the trend beside it. There is no verb
      // for the apply because there is nothing destructive to guard — and the
      // trend is always printed, so the read is never ambiguous.
      case "scenarios":
        if (rest.length > 0) {
          await cmdApplyScenario(ctx, rest.join(" "), parsed.range);
          break;
        }
        await cmdScenarios(ctx);
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
      case "routing":
        if (rest[0] === "queue") {
          await cmdRoutingQueue(ctx, parsed.range.limit);
          break;
        }
        await cmdRouting(ctx);
        break;
      case "expiring":
        await cmdExpiring(ctx);
        break;
      case "posture":
        if (rest[0] === "dismiss") await cmdPostureDismiss(ctx, rest.slice(1));
        else if (rest[0] === "restore") await cmdPostureRestore(ctx, rest.slice(1));
        else await cmdPosture(ctx);
        break;
      case "dns":
        await cmdDns(ctx);
        break;
      case "changes":
        await cmdChanges(ctx, parsed.range);
        break;
      case "diff":
        // `infrawrench diff staging prod` is the same as -a/-b; the two
        // positionals are the only ones this command could take.
        await cmdDiff(ctx, rest, parsed.diff, parsed.range);
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
      case "recordings":
        await cmdRecordings(ctx, rest, { file: parsed.push.file });
        break;
      case "access":
        await cmdAccess(ctx, rest);
        break;
      case "hygiene":
        await cmdHygiene(ctx, { days: parsed.range.days });
        break;
      case "credits":
        await cmdCredits(ctx);
        break;
      case "commitments":
        await cmdCommitments(ctx);
        break;
      case "probes":
        // `infrawrench probes <id|name>` charts one probe's latency history.
        await cmdProbes(ctx, rest[0]);
        break;
      case "declared-incidents":
        // Incidents *we* declared (incident mode), as opposed to `incidents`
        // above, which is the provider status-page correlation. Two features,
        // one English word; the long name is what keeps them apart.
        await cmdDeclaredIncidents(ctx, rest[0]);
        break;
      case "status-pages":
        // `infrawrench status-pages <name|id>` details one page's components.
        await cmdStatusPages(ctx, rest[0]);
        break;
      case "ownership":
        // `infrawrench ownership <query>` filters to matching resources.
        await cmdOwnership(ctx, rest[0]);
        break;
      case "graph":
        // `infrawrench graph <resource-id>` is the same as --resource; a
        // resource id is the only positional this command could take.
        await cmdGraph(ctx, rest[0] ? { ...parsed.range, resource: rest[0] } : parsed.range);
        break;
      case "blast-radius":
        // `infrawrench blast-radius <resource-id>` — the full impact report,
        // not just the graph's share of it.
        await cmdBlastRadius(ctx, rest[0]);
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
      case "config":
        await cmdConfig(ctx, rest[0], parsed.config);
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
