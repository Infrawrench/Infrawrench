// Headless CLI runner. Reached via the bootstrap in electron/index.ts when
// the process was launched with --cli (normally through the `infrawrench`
// shell shim). Runs the full Electron app object (safeStorage needs it for
// the master key) but never opens a window, registers a protocol, or keeps
// the single-instance lock.
import { app } from "electron";
import { wireDbGetter, setDatabaseReadOnly } from "../db";
import { setRequireExistingEncryptionKey, UserFacingError } from "../main-utils";
import { setTokenStoreReadOnly } from "../cloud-tokens";
import { parseCliArgs, scanCommandLine } from "./args";
import { CliError, type CliContext } from "./context";
import { setColorEnabled, printErr, println, c } from "./output";
import { cmdVulns, cmdVulnsDismiss, cmdVulnsRestore, cmdVulnsSources } from "./commands/vulns";
import { cmdJit } from "./commands/jit";
import { cmdScorecards } from "./commands/scorecards";
import { cmdLeaks } from "./commands/leaks";
import { cmdDeploy } from "./commands/deploy";
import { cmdSshFanout } from "./commands/ssh-fanout";
import { cmdApps } from "./commands/apps";
import { cmdConfig } from "./commands/config";
import { runTui } from "./tui";
import { migratedCommands } from "./effect/root";
import { runEffectCli } from "./effect/run";

const HELP = `infrawrench: manage your infrastructure from the terminal

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
  export --format focus [<report n|id>]
                      cost rows as a FOCUS 1.4 CSV (stdout, or --out <file>)   [--last 30d]
                      [--where …] [--filter <name|id>] [--charge-type …] [--focus-version 1.3];
                      a report brings its
                      own range and filters, range flags override the range
  export --async --format csv|ndjson|focus [<report n|id>]
                      a background export job on the server, for ranges and files too big for one
                      download (up to 731 days); a report exports its scope, group-by and per-day
                      unit cost   [--wait  follow it and write the file to stdout or --out]
                      [--dimensions service,account  rows per dimension, without a report]
  export jobs [<id> [cancel]]
                      your recent export jobs; one job's status (--wait downloads it); cancel one
  estimate <id|name>  what a resource costs per month at list price, itemized (cloud only;
                      full id, or a name/external-id with --account)
  costs               org cost graphs   [--last 30d] [--group-by provider|account|service|region|resource|charge_type|commitment]
                      [--group-by tag:<key> | virtual_tag:<key> | k8s_node_label:<key> | k8s_pvc_label:<key> | k8s_pod_label:<key>
                       group by a provider tag, a virtual tag or a Kubernetes label]
                      [--basis cash|amortized|blended] [--charge-type usage|credit|tax|… (repeatable)]
                      [--currency USD  convert to your org's display currency (stated rates, then
                      automatic ECB rates if on)]
                      [--where "provider = 'aws' AND tag['env'] != 'dev'"  filter, as text]
                      [--filter <name|id>  a saved cost filter, resolved server-side; ANDs with --where]
                      [--measure cost|usage|count] [--unit <usage unit>] [--bin day|week|month|quarter|hour]
                      [--cumulative] [--compare  the previous period, with the change]
                      [--x-axis service|region|tag:<key>|…  one bar per value instead of dates;
                      --group-by then splits each bar] [--segment-by-date  split each bar by bin]
  costs --anomalies   days a provider or service spiked past its own baseline, with any
                      verdict or suppression in the feedback column   [--days 30]
    feedback <id>     tell detection what a spike was (id or its first characters, from the
                      listing's id column): --expected | --unexpected | --clear
                      [--reason planned_launch|migration|seasonal|pricing_change|data_issue|other]
                      [--note <text>] [--explain  publish the note as the explanation]
                      [--recurrence one_off|weekly|monthly|seasonal  expected only: stop the
                      pattern alerting] [--expires YYYY-MM-DD  when that suppression ends]
    suppressions      what is kept from alerting: scope, recurrence, window, hits, reason
    suppressions delete <id>   remove one; matching spikes alert again
    precision         per-month share of reviewed findings marked unexpected   [--months 6]
    sensitivity       providers/services whose threshold feedback has raised, and why
  costs --alerts      change-based cost alerts + recent firings ("spend moved >X% vs the
                      prior period", distinct from budgets and anomalies)   [--limit 20]
  costs tag-keys      the tag keys in your cost data, Kubernetes node and volume labels grouped   [--json]
  costs forecast <report>
                      a saved report's projected spend with its low/expected/high band: the
                      report's default forecast, or [--forecast <name|id|auto>]
                      [--from / --to YYYY-MM-DD  the projected window; default 90 days]
                      [--provider aws,gcp] [--service <name>,...  narrow the scope]
                      [--level 80|90|95  band level] [--all  every named forecast side by side]
  costs forecasts <report>
                      a report's named forecasts, the default marked   [--json]
  costs push          push your own cost rows   --source <name> [--file rows.json | stdin]
                      into a custom source: --format csv|focus [--map date=Day --map tag=Team]
                      [--currency USD] [--date-format mdy|dmy] [--replace | --append]
  costs sources       custom cost sources (uploaded spend); "costs sources <name>" for history
  budgets             every budget as a tree (a parent is the sum of its children): this
                      period's actual and forecast vs its limit, in money or a usage unit,
                      with fired alerts and children that outgrow their parent
  reports             the org's saved cost reports (named cost graphs)
  reports <name|id>   run one saved report and chart it
                      [--measure cost|usage|count] [--unit <u>] [--bin …] [--cumulative]
                      [--x-axis <dimension>|date]
                      (one-off view of the report; nothing is saved)
                      [--format pdf [--out <path>]  save the rendered PDF instead]
  reports send <n|id> deliver a report to its schedules (Slack/Teams/email) right now
  reports anomalies [<n|id>]
                      reports that watch their own scope for anomalies: sensitivity, floor,
                      destinations and the latest findings (set up on the report page)
  canvas list         cost canvases: reports the chat agent built from a description
  canvas show <n|id>  one canvas's definition (blocks, placements, prompt)
                      [--format pdf [--out <path>]  save the rendered canvas as a PDF]
  canvas refresh <n>  re-run a canvas's queries (no model call) and print its figures
  reports move <item>... --folder <path|id|top>
                      file reports (and folder:<path> folders) into one folder, all or nothing
  reports delete <item>... [-y]
                      delete reports and folders, all or nothing (asks first without -y)
  resource-reports    saved inventory reports: synced resources with picked columns & cost
  resource-reports <name|id>
                      run one: a page of rows with its tag, metadata & cost columns
                      [--limit n] [--offset n] [--sort <column> [--desc]]
                      [--format csv [--out <path>]  every row as CSV instead]
  budgets <name|id>   one budget's alert history, with the note on each firing
  budgets annotate <name|id> --note <text> [--event <id>]
                      explain a fired budget alert (the latest by default); the note shows on
                      the budget, on cost charts at that day, and in the alert's Slack thread
  dashboards          the org's dashboards, which one you land on, and scheduled PDF deliveries
  dashboards <n|id>   one dashboard's KPI card figures and delivery schedules
                      [--format pdf [--out <path>]  save the rendered dashboard as a PDF]
  dashboards send <n> deliver a dashboard to its schedules now (PDF attached to email/Slack)
  exports             scheduled cost exports (raw rows → warehouse/object store), with the
                      last run's status and error
  exports run <n|id>  run one export now and list the objects it wrote
  exports warehouses  Snowflake/Databricks destinations, your accounts of each, and the
                      --target keys they take
  exports create      a warehouse export: load rows into a Snowflake or Databricks table
                      --name <n> --plugin snowflake|databricks -a <account> --target k=v ...
                      [--cadence daily|weekly|monthly] [--hour 4] [--timezone UTC]
                      [--restatement-days 7] [--dimensions provider,account,service,region]
  exports setup <n>   the least-privilege GRANT statements a warehouse export needs
  tags                org tag policy, per-account compliance & untagged spend   [--last 30d]
  tag-keys            every tag key in cost data and inventory, with providers, usage and
                      whether the org hides it from pickers or pins it to the top
  tag-keys hide <k>   hide a key, or a prefix like 'aws:cloudformation:*', from every picker
                      (data untouched; still queryable)   also: unhide <k>, pin <k>, unpin <k>
  showback            spend by cost centre via the org's allocation rules, as an indented
                      tree; a parent's bar is its subtree total   [--last 30d]
  ai-spend [dim]      billed AI spend split by a caller dimension (team, user, feature…), with
                      per-source match rates and per-provider coverage   [--last 30d]
  ai-spend sources    the org's AI request-log sources and their collection state
  billing-rules       the org's own adjustments to collected spend (markups, discounts, fixed
                      charges, reallocations): why a report may not match the invoice
  billing-rules <n>   one rule in full, by name or id
  billing-rules preview <n>
                      dry-run one rule against a month of real spend: totals without and
                      with it, and the lines it moved   [--customer <name>] [--month YYYY-MM]
  virtual-tags        the org's virtual tags (keys computed from ordered rules, usable as
                      virtual_tag['key'] in --where and --group-by virtual_tag:<key>; a tag's
                      rules may filter on other virtual tags, up to five deep) with status
  virtual-tags show   one tag in full: rules, processing status, spend each rule claims and the
       <key|id>       share left unmatched
  virtual-tags reprocess <key|id>
                      re-run a tag's background evaluation over the stored history now
  currency            display currency, automatic-rate settings, ECB feed state and stated rates
  currency rate <FROM> [TO] [YYYY-MM-DD]
                      the rate a day of spend converts at under your org's rules, its source
                      (stated or ECB) and date, and why
  currency feed [YYYY-MM-DD]
                      the ECB reference rates for a day   [--currency USD  express them in USD]
  currency import <file.csv>
                      upload many stated rates; previews every row (new, replaces, unchanged,
                      error) and asks before writing   [--skip-invalid] [-y]
  currency template   the CSV template an import reads, on stdout
  invoices           invoices raised against managed accounts (customers), newest first; a
                      draft's total is not computed in the list, an issued one is frozen
  invoices customers  the managed accounts themselves: billing currency, cost basis and the
                      cost centres whose spend is theirs
  invoices profiles [n]
                      billing profiles: addressee, tax, terms, numbering and the customers on
                      each; with a name, one in full (account numbers masked; --json has them)
  invoices unassigned spend no customer is billed for, by cost centre and account
                      [--from YYYY-MM-DD --to YYYY-MM-DD; default the last full month]
  invoices <n|id>     one invoice in full, by number, id or customer: lines, the adjustments
                      applied, the rate used and the day it was read
  unit-costs          the org's business metrics (the denominators unit costs divide by) and
                      how well each one is being reported
  scenarios           scenario models: known future cost the trend can't see (a purchase, a
                      new team, a migration)
  scenarios <name>    apply one to the forecast; prints the unadjusted trend alongside, always
                      [--last 30d]
  unit-costs sources  accounts that can feed a business metric on a schedule, and the fields
                      each one's importer takes
  unit-costs importer <key> [show|runs|run|set|enable|disable|delete]
                      a metric's scheduled importer: config + recent runs, run now
                      [--from --to to backfill], or set [--account <id|name>]
                      [--set field=value …, @file reads a value] [--file importer.json]
  unit-costs <key>    cost per unit of a business metric over time; a period with no reported
                      value prints as "—", never as 0   [--last 30d]
                      [--group-by daily|weekly|monthly|cumulative] [--basis cash|amortized|blended]
                      [--currency USD] [--where "…"] [--margin  revenue metrics only]
                      [--mode unit|margin|raw] [--scale 1|100|1k|1m|1b]
                      [--label customer=acme,globex] [--label plan!=free] [--split customer]
                      [--format csv|ndjson  the series as a file on stdout: one row per bucket
                      per series with the spend and metric value behind each ratio; also works
                      with --usage-unit]
  unit-costs <key> --labels
                      the metric's labels, their values, and which cost dimension each maps to
  unit-costs --usage-units
                      the usage units your cost rows carry (GB-Mo, Hrs, Requests…)
  unit-costs --usage-unit <unit>
                      cost per provider usage unit, no business metric needed [--scale 1m]
  orphans             likely-wasted resources (unattached volumes, idle IPs, and idle NAT
                      gateways, load balancers, caches and tables flagged from their metrics)
                      with reasons, evidence, cost or list-price estimate and ready-to-run
                      remediation commands (--local scans this machine's workspace; no cost
                      column and no metric-based findings without the cloud)
  idle-rules          the metric-based idle rules, the org's thresholds and lookback, and each
                      account's last collection or error (cloud only)
  idle-rules rescan   make every account due for an idle collection now
  oversized           machines whose 14-day p95 utilisation sits well under their size, with the
                      recommended smaller size, monthly saving and resize commands (cloud only)
  prices search [q]   providers' list prices, filtered and sorted by monthly price (cloud only)
                      [--provider aws,gcp] [--area europe] [--region <id>] [--min-vcpus 4]
                      [--max-vcpus 8] [--min-memory 16] [--max-memory 64] [--gpu required|none]
                      [--gpu-model H100] [--max-price 200] [--rate on-demand|spot|reserved|
                      savings-plan] [--term 1yr|3yr] [--sort price|vcpus|memory|gpus|name] [--desc]
  prices compare      the cheapest instance per provider meeting a spec   [--vcpus 4] [--memory 16]
                      [--gpus 1] [--gpu-model L4] [--area europe] [--rate spot], or a product's
                      specs: prices compare <sku> --provider <plugin>
  github-issues       findings filed as GitHub issues, open first, with any pull request
  github-issues settings  repository routing, Terraform sources and each GitHub App
                      installation's granted permissions (cloud only)
  issues              findings filed to Jira, Linear and GitHub with each issue's live status
                      and assignee, unfinished first   [jira|linear|github] (cloud only)
  pr-check            the pull request check (monthly cost change, blast radius, warnings) for
                      the local working tree vs a base, or for an open pull request; posts
                      nothing   [--base origin/main] [--repo owner/name] [--pr 42] (cloud only)
  extended-support    clusters & databases on versions billed at extended-support / end-of-life
                      rates, with the monthly surcharge an upgrade removes (--local: list price)
  seats               paid SaaS seats to act on: inactive, duplicated across tools, or on a
                      dearer tier, with remediation commands (cloud only)
  seats all           every seat, its last activity and how that was determined
  seats remove <id>   remove a flagged seat through its provider   [-y]
  seats refresh       re-collect seats now
  carbon              estimated CO2e of the estate by provider, region and resource, with what
                      could not be estimated and the assumptions   [--days 30] (cloud only)
  k8s-efficiency      saved Kubernetes efficiency reports (cloud only)
  k8s-efficiency <name|id>
                      run one: total, used, requested-but-unused, unmeasured, idle and overhead
                      cost, efficiency %, by cost category and by group
                      [--format csv|ndjson] [--out <path>] (the per-period export)
  k8s-efficiency --group-by <cluster|namespace|workload|node_pool|category|label-key>
                      the same, unsaved, over every cluster you can see
                      [--last 30d] [--basis total|allocated]
  k8s-network [cluster]
                      a Kubernetes cluster's network costs by traffic class (same zone,
                      cross-zone, cross-region, internet), namespace and workload, top talkers,
                      and its billed data transfer apportioned   [--last 14d] (cloud only)
  network-reports [name|id]
                      list saved network flow reports, or run one: bytes and estimated cost
                      by flow pair, traffic class, zone or VPC over time, and the top talkers
                      [--format csv|pairs-csv] [--out file.csv] (cloud only)
  alerts              metric threshold alert rules ("CPU > 90% for 15m") with live firing status
  alerts events       recent metric alert firings & recoveries   [--limit 50]
  routing             alert routing rules, in evaluation order
  routing queue       alerts held for quiet hours or awaiting ack [--limit 50]
  routing email       alert email policy and unsubscribed addresses
  expiring            certificates, domains, tokens & keys approaching expiry, soonest first
                      (--local scans this machine's workspace)
  posture             security posture findings (public buckets, world-open ingress, unencrypted
                      disks), ranked by severity   (--local scans this machine's workspace)
  posture dismiss     accept a finding as a known risk; it leaves the list and the daily alerts
                      <resourceId> <ruleId> [--reason <text>]   (ids from posture --json)
  posture restore     put a dismissed finding back   <resourceId> <ruleId>
  leaks               leaked credentials: secrets GitHub/GitLab secret scanning found in code,
                      what each matched (an account, a stored secret) and the scanners' state
                      [--status open|rotated|dismissed|resolved|all] [--account <id|name>]
  leaks scan          scan every scanner account now
  leaks rotate <id>   reissue the matched secret, or store a replacement read from stdin
                      [--value-stdin] (account/manual leaks: prints where to rotate instead)
  leaks mark-rotated <id>
                      record a rotation done at the provider
  leaks dismiss <id>  accept it   --reason false-positive|wont-fix|used-in-tests [--comment <c>]
  leaks reopen <id>   undo a dismissal or a manual rotation
                      (rotate, mark-rotated and dismiss also close the finding on the scanner;
                      --keep-upstream-open leaves it open; cloud only)
  vulns [list]        known vulnerabilities (CVEs) from your providers' scanners, joined to what
                      runs them, worst first   [--severity critical,high] [--running|--not-running]
                      [--fix-available] [--kev] [--plugin <id>] [-a <account>] [--search <text>]
                      [--service <slug>] [--resource <id>] [--include-dismissed] [--limit 50]
                      (cloud only; a service column names the owning services)
  vulns dismiss       accept an advisory as a known risk, for one artifact or everywhere ("*")
                      <advisoryId> <artifactKey|"*"> [--reason <text>]   (keys from vulns --json)
  vulns restore       put a dismissed vulnerability back   <advisoryId> <artifactKey|"*">
  vulns sources       scanner accounts, when each last collected, errors and help links
  compliance [status] controls of a compliance framework with evidence, gaps & owners, plus the
                      evidence sources behind them   [--framework soc2|iso27001] [--gaps]
                      [--from YYYY-MM-DD] [--to YYYY-MM-DD]  (default: last 90 days; cloud only)
  compliance export   save the auditor's evidence pack as a ZIP   [--framework ...] [--from] [--to]
                      [--out <path>]  (default file: <framework>-evidence-<from>-to-<to>.zip)
  compliance frameworks   the frameworks Infrawrench can report on
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
  savings             realized savings: what resizes, cleanups, schedules & commitments
                      actually saved vs projected   [--from] [--to] [--group-by month|kind|cost-centre|account]
  savings log "<what>" log a saving by hand   --amount <monthly> [--currency USD] [--from <day>] [--note]
  savings findings    every savings finding with its status, detected date & summary
                      [--status open|ready|in_progress|completed|archived|all] [--kind orphan|oversized|
                      extended_support|seat] [--provider] [-a/--account] [--region] [--tag key[=value]]
                      [--min-savings <monthly>] [--from/--to <detected day>] [--search] [--view <name>]
                      [--sort savings|detected|name|status_changed[:asc|desc]]
  savings findings set <key>... --status <status> [--note "..."]   change findings' status
  savings views       saved views over the findings list
  hygiene             unused API keys, unreferenced SSH keys & unexercised
                      write permissions   [--days 30|90|180|365]
  agents              agent credentials that can reach this org: who claimed
                      each one, when it was last used & which are unclaimed
  access active       only the elevations in force right now
  jit                 just-in-time access to cloud roles: the queue, live grants & failed revokes
                      [--mine] [--holding] [--status pending|active|revoke_failed|…]
  jit policies        the policies you can request under, and what each offers
  jit request         ask for a role   --policy <name> --role <name> [--scope <name>] --for 2h
                      --reason "…" [--ticket <ref>]
  jit approve|deny <id>  decide a request (you must be one of its approvers)   [--note "…"]
  jit cancel <id>     withdraw your pending request
  jit extend <id>     lengthen an active grant, within the policy maximum   --by 30m
  jit revoke <id>     end a grant now and remove it from the provider
  cost-visibility     cost visibility scopes on roles, members & API keys
  cost-visibility me  whether your own cost figures are scoped
  recordings          recorded SSH sessions: who connected, to what, for how long
  recordings get <id> print the session's asciicast   [-f/--file <path>]
                      (pipe it: infrawrench recordings get <id> | asciinema play -)
  search <query>      the Cmd+K index: resources, workflows, reports, dashboards, budgets,
                      SLOs, services, runbooks and more you can open, best match first, each
                      with its web address   [--kind cost_report,slo,…]
  starred             your starred items in this org (listed first in Cmd+K)
  starred add|remove <kind> <id>
                      star or unstar one (kind and id as "search --json" prints them)
  probes [id|name]    synthetic uptime/latency checks probed from outside your infra, with
                      live status, 24h uptime & last latency (give an id/name for its chart)
  slos [id|name]      service-level objectives: SLI against target, error budget left (as a
                      share and as time) & burn rate (give an id/name for its burn rates & charts)
  services [list]     services (resources grouped across providers): tier, owners, member count
                      & level per scorecard   [--tier 1-4]
  services show <id|slug|name>
                      one service: owners, links, on-call now & next, 30-day cost, SLOs,
                      runbooks, findings, members, recent changes & why each scorecard check
                      failed (--json: { service, members, excluded, summary, scorecards, history })
  scorecards [id|name]  the org grade (seven pillars, 90-day trend) above every service ×
                      scorecard, score % and level per cell (give an id/name for its checks,
                      weights, levels & each service's score with a 90-day trend)
  dora [changes|restores|settings]
                      DORA metrics for production: deploy frequency, lead time, change failure
                      rate & time to restore, with bands, the previous period & a trend
                      [--last 30d] [--scope <dim>=<value>] [--group-by <dim>]
                      (dora changes [--failed]: only the changes that failed)
  status-pages [name] public status pages built from your probes: what each publishes and the
                      URL it is live at (give a name/id for its components)
  declared-incidents  incidents YOU declared (incident mode): severity, status, duration & whether
       [id|title]     anything the declaration asked for failed (give an id/title for its joined
                      timeline). "incidents" above is the other kind, the providers'.
  paging [--all]      incidents mirrored from PagerDuty / incident.io (open ones; --all adds
                      resolved). paging ack|resolve <ref> writes back upstream as you;
                      paging events lists the alerts Infrawrench opened upstream
  webhooks            event subscriptions (signed webhooks, EventBridge, Pub/Sub) and their
       [list|test|    health; webhooks test <id|name> sends a test event now; webhooks
        deliveries]   deliveries [id|name] is the delivery log
  ownership [query]   who owns each resource, what it's for & its ticket (a resource absent
                      from this list is unowned; see orphans for the wasted ones)
  graph               resource dependency tree   [--resource <id>: what it needs + its blast radius]
  blast-radius <id>   what breaks if a resource is deleted: dependants, the dashboards/probes/
                      alerts/leases that point at it, what talks to it, and what wasn't checked
  apps <resource>     graphical applications installed on a Linux host
                      (--check what it is missing, --install to fix it)
                      (--launch <id> opens one in the app; --key, --user to connect)
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
  deploy destroy      run the Infrafile's destroy() stage: tear the env down   [-e <env>] [--created]
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
  --kind <k>          changes filter: created | updated | deleted; search: comma-separated
                      kinds (resource, workflow, cost_report, dashboard, budget, slo, …)
  -b, --against <x>   diff: the second account (-a supplies the first)
  --all               diff: compare ids, addresses & timestamps too; paging: include resolved
  --resource <id>     focus one resource (graph) / filter to it (changes, vulns)
  -w, --window <d>    moment half-window, e.g. 30m, 1h, 6h (± around the timestamp)
  --type <typeId>     filter resources by resource type
  --severity <list>   vulns: comma-separated critical, high, medium, low, unscored
  --running / --not-running   vulns: only findings whose artifact is (or is not) running
  --fix-available     vulns: only findings the scanner names a fixed version for
  --kev               vulns: only advisories in the CISA Known Exploited Vulnerabilities catalog
  --search <text>     vulns: substring over advisory, aliases, package, artifact & title
  --include-dismissed vulns: also list the findings dismissed as accepted risks
  --service <x>       vulns: only findings running on a resource of this service (id, slug or name)
  --framework <id>    compliance: soc2 (default) or iso27001; see compliance frameworks
  --gaps              compliance: only controls without evidence, with the reasons why
  --format <fmt>      export format: terraform (default) or focus (csv, ndjson or focus with --async);
                      pdf for reports/dashboards <name|id> and canvas show|refresh; csv or ndjson
                      for unit-costs <key> and k8s-efficiency <name|id>; costs push: json
                      (default), csv or focus; network-reports <name|id>: csv or pairs-csv;
                      resource-reports <name|id>: csv
  --reason <text>     posture / vulns dismiss: why the finding is an accepted risk; costs --anomalies
                      feedback: the reason category (planned_launch, migration, …); leaks
                      dismiss: false-positive, wont-fix or used-in-tests
  --status <s>        leaks: open (default), rotated, dismissed, resolved or all; jit: queue filter
  --comment <text>    leaks dismiss: a note kept with the dismissal
  --value-stdin       leaks rotate: read the replacement value from stdin (hidden at a terminal)
  --keep-upstream-open  leaks rotate|mark-rotated|dismiss: leave the finding open on the scanner
  --expected / --unexpected / --clear   costs --anomalies feedback: the verdict, or withdraw it
  --note <text>       costs --anomalies feedback: context for the verdict (max 500 chars)
  --explain           costs --anomalies feedback: also publish --note as the explanation
  --recurrence <r>    costs --anomalies feedback --expected: suppress the pattern
                      (one_off | weekly | monthly | seasonal)
  --expires <date>    costs --anomalies feedback: last day the suppression covers (YYYY-MM-DD)
  --months <n>        costs --anomalies precision: months to report (default 6, max 24)
  --where <query>     costs: filter in the cost query language; terms joined by AND, each
                      dimension = 'v' | != 'v' | IN ('a','b') | NOT IN ('a','b'), plus
                      tag['key'] = 'v', k8s_node_label['key'] = 'v', k8s_pvc_label['key'] = 'v'.
                      Text matches ignore letter case: ~= 'prod-env' (also ignores spaces,
                      _ and -, so Prod_Env matches), CONTAINS 'x', NOT CONTAINS 'x',
                      STARTS WITH 'x' (each also takes a list). Tags: tag['key'] IS SET,
                      tag['key'] IS NOT SET. Dimensions: provider, account, service, region,
                      resource, tag, charge_type, commitment, virtual_tag. OR is not
                      supported (the filter is a conjunction); use IN ('a','b') for several
                      values of one dimension
  --filter <name|id>  costs: apply a saved cost filter by reference, resolved on the server
                      at query time, so it always means what it means everywhere else; combines
                      with --where by AND
  --measure <m>       costs/reports: what to sum. cost (default, money), usage (the usage
                      quantity providers report; needs --unit, since hours and gigabytes
                      cannot be added) or count (how many distinct --group-by values had
                      nonzero cost per bin; its total counts each value once)
  --unit <u>          costs/reports --measure usage: the unit to sum, as the provider spells
                      it (e.g. Hrs, GB-Mo); run without it to list the units present
  --bin <b>           costs/reports: day (default for costs), week, month, quarter, or hour
                      (refused while every provider reports daily rows)
  --cumulative        costs/reports: running totals from the start of the range
  --x-axis <d>        costs/reports: put a dimension's values on the X axis (one bar per value,
                      ranked, the tail folded into other) instead of date bins; same spelling as
                      --group-by, which then splits each bar. reports: "date" puts the bins back
  --segment-by-date   costs --x-axis without --group-by: split each value's bar by date bin
  --compare           costs: add the previous period of the same length; with --x-axis each
                      value is compared with itself
  --margin            unit-costs: draw (revenue − cost) ÷ revenue instead of cost per unit.
                      Only for a metric declared revenue-shaped; the server refuses it for a
                      count metric rather than returning a plausible wrong number
  --source <name>     who is pushing (required by page and costs push)
  --key <k>           page throttle key   --title <t>   --cooldown <min>   --voice
  -f, --file <path>   JSON rows / CSV / FOCUS file for costs push, config document (stdin when omitted);
                      recordings get: where the asciicast goes; anywhere --out is taken, the same
  --map <field=col>   costs push --format csv: map a column (date, cost, currency, service,
                      account, region, resource, usageQuantity, usageUnit, tags; tag=<col> keeps
                      a column as a tag). Repeatable; unmapped fields are auto-detected
  --replace/--append  costs push into a custom source: what to do when the dates overlap an
                      earlier upload (required then)
  --out <path>        config export / export --format focus: write here instead of stdout;
                      reports/dashboards/canvas --format pdf: the PDF's path (default: <name>.pdf
                      here); compliance export: the ZIP's path; network-reports, k8s-efficiency
                      and resource-reports --format: the CSV's path
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
  --user <name>       ssh-fanout, apps: username override for VM hosts
  --launch <app-id>   apps: open this application in the desktop app
  --snippet <name>    ssh-fanout: run a saved command instead of a literal one
  -y, --yes           skip the confirmation (ssh-fanout's "Run on N hosts?", config apply's plan,
                      currency import's preview, reports delete)
  --skip-invalid      currency import: write the valid rows of a file that has invalid ones
  --async             export: queue a background export job instead of streaming the file
  --wait              export --async / export jobs <id>: poll until the file is ready, then write it
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
 *   a closed terminal → EIO). Both mean nobody is reading: exit quietly.
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
      // stderr itself is what broke: nothing left to say it with.
    }
    app.exit(1);
  });
}

/**
 * True when the GUI already runs: probe the single-instance lock.
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

/**
 * Everything a command needs before it runs, migrated or not. Order is
 * load-bearing: see detectGuiRunning(). Ready first, probe second.
 */
async function bootstrap(): Promise<boolean> {
  await app.whenReady();
  const guiRunning = detectGuiRunning();

  wireDbGetter();
  setDatabaseReadOnly(guiRunning);
  setTokenStoreReadOnly(guiRunning);
  // The GUI owns first-run key creation. A terminal session that can't reach
  // the keychain must fail loudly rather than mint a key that orphans every
  // stored credential.
  setRequireExistingEncryptionKey(true);
  return guiRunning;
}

export async function runCli(): Promise<void> {
  installTerminalGuards();
  // Terminal process: no GPU, no dock icon, as little Chromium as possible.
  app.commandLine.appendSwitch("disable-gpu");
  if (process.platform === "darwin") app.dock?.hide();

  const argv = process.argv.slice(process.argv.indexOf("--cli") + 1);

  let exitCode = 0;
  try {
    // A command migrated to effect/cli parses its own line (flags, --help,
    // --version) through `effect/root.ts`; everything else takes the switch
    // below. Bare `infrawrench`, `help` and `--help` stay here: HELP lists
    // every command, migrated or not.
    const { command: first, noColor } = scanCommandLine(argv);
    if (first !== undefined && migratedCommands.has(first)) {
      setColorEnabled(!noColor && process.stdout.isTTY === true && !process.env.NO_COLOR);
      const guiRunning = await bootstrap();
      app.exit(await runEffectCli(argv, { version: app.getVersion(), guiRunning }));
      return;
    }

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

    const guiRunning = await bootstrap();

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
      case "apps":
        await cmdApps(ctx, rest[0] ?? "", parsed.apps);
        break;
      case "leaks":
        // Leaked credentials: the Posture tab's "Leaked credentials" category.
        await cmdLeaks(ctx, rest, parsed.leaks);
        break;
      case "vulns":
      case "vulnerabilities":
        if (rest[0] === "dismiss") await cmdVulnsDismiss(ctx, rest.slice(1));
        else if (rest[0] === "restore") await cmdVulnsRestore(ctx, rest.slice(1));
        else if (rest[0] === "sources") await cmdVulnsSources(ctx);
        else if (rest[0] === undefined || rest[0] === "list") {
          await cmdVulns(ctx, parsed.vulns, parsed.range);
        } else {
          throw new CliError(
            `Unknown "${rest[0]}". \`vulns\` takes list, dismiss, restore or sources.`,
            2,
          );
        }
        break;
      case "jit":
        await cmdJit(ctx, rest, parsed.jit);
        break;
      case "scorecards":
        // `infrawrench scorecards <id|name>` shows one scorecard's checks and results.
        await cmdScorecards(ctx, rest.join(" ") || undefined);
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
      default:
        printErr(`Unknown command "${command}". Run \`infrawrench help\`.`);
        exitCode = 2;
    }
  } catch (e) {
    // A stack trace is for a bug in here, not for a typo'd flag or a locked
    // keychain: those print as a single line.
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
