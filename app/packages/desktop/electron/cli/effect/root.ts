// The `infrawrench` root command: the global flags as shared flags (so they
// parse before or after the subcommand, `--org x` and `--org=x` alike), every
// command, and a handler of its own for bare `infrawrench` (the TUI at a
// terminal, the root help elsewhere). `runCli` hands every command line here.
//
// A new command is one entry in `subcommands`. The root turns the parsed
// flags into the `CliSession` every handler reads, after help and version
// have had their turn.
import { Command } from "effect/cli";
import { login, logout, whoami } from "../commands/auth";
import { agents } from "../commands/agents";
import { cli } from "../commands/cli-install";
import { dns } from "../commands/dns";
import { accounts, resource, resources } from "../commands/listing";
import { orgs } from "../commands/orgs";
import { blastRadius } from "../commands/blast-radius";
import { githubIssues } from "../commands/github-issues";
import { idleRules } from "../commands/idle-rules";
import { leases } from "../commands/leases";
import { oversized } from "../commands/oversized";
import { ownership } from "../commands/ownership";
import { access } from "../commands/access";
import { costVisibility } from "../commands/cost-visibility";
import { credits } from "../commands/credits";
import { expiring } from "../commands/expiring";
import { incidents } from "../commands/incidents";
import { schedules } from "../commands/schedules";
import { declaredIncidents } from "../commands/declared-incidents";
import { estimate } from "../commands/estimate";
import { issues } from "../commands/issues";
import { statusPages } from "../commands/status-pages";
import { commitments } from "../commands/commitments";
import { extendedSupport } from "../commands/extended-support";
import { orphans } from "../commands/orphans";
import { probes } from "../commands/probes";
import { slos } from "../commands/slos";
import { webhooks } from "../commands/webhooks";
import { alerts } from "../commands/alerts";
import { carbon } from "../commands/carbon";
import { changes } from "../commands/changes";
import { moment } from "../commands/moment";
import { metrics } from "../commands/metrics";
import { graph } from "../commands/graph";
import { search, starred } from "../commands/search";
import { showback, tags } from "../commands/tags";
import { k8sNetwork } from "../commands/k8s-network";
import { aiSpend } from "../commands/ai-spend";
import { scenarios } from "../commands/scenarios";
import { billingRules } from "../commands/billing-rules";
import { savings } from "../commands/savings";
import { dora } from "../commands/dora";
import { currencyCommand } from "../commands/currency";
import { hygiene } from "../commands/hygiene";
import { routing } from "../commands/routing";
import { networkReports } from "../commands/network-reports";
import { k8sEfficiency } from "../commands/k8s-efficiency";
import { resourceReports } from "../commands/resource-reports";
import { recordings } from "../commands/recordings";
import { dashboards } from "../commands/dashboards";
import { canvas } from "../commands/canvas";
import { reports } from "../commands/reports";
import { compliance } from "../commands/compliance";
import { costs } from "../commands/costs";
import { page } from "../commands/push";
import { budgets } from "../commands/budgets";
import { tagKeys } from "../commands/tag-keys";
import { virtualTags } from "../commands/virtual-tags";
import { invoices } from "../commands/invoices";
import { unitCostsCommand } from "../commands/unit-costs";
import { exportCommand } from "../commands/export";
import { exportsCommand } from "../commands/exports";
import { paging } from "../commands/paging";
import { seats } from "../commands/seats";
import { diff } from "../commands/diff";
import { posture } from "../commands/posture";
import { prices } from "../commands/prices";
import { prCheck } from "../commands/pr-check";
import { services } from "../commands/services";
import { jit } from "../commands/jit";
import { leaks } from "../commands/leaks";
import { vulns } from "../commands/vulns";
import { scorecards } from "../commands/scorecards";
import { apps } from "../commands/apps";
import { sshFanout } from "../commands/ssh-fanout";
import { config } from "../commands/config";
import { deploy } from "../commands/deploy";
import { help, home, tui } from "../commands/tui";
import { CliSession, globalFlags, makeSession } from "./session";

const subcommands = [
  login,
  logout,
  whoami,
  orgs,
  cli,
  agents,
  dns,
  accounts,
  resources,
  resource,
  leases,
  ownership,
  blastRadius,
  oversized,
  githubIssues,
  idleRules,
  incidents,
  access,
  expiring,
  schedules,
  credits,
  costVisibility,
  statusPages,
  declaredIncidents,
  issues,
  estimate,
  orphans,
  extendedSupport,
  probes,
  webhooks,
  slos,
  commitments,
  hygiene,
  carbon,
  alerts,
  routing,
  changes,
  moment,
  metrics,
  graph,
  search,
  starred,
  tags,
  showback,
  k8sNetwork,
  aiSpend,
  scenarios,
  billingRules,
  savings,
  dora,
  currencyCommand,
  networkReports,
  k8sEfficiency,
  resourceReports,
  recordings,
  dashboards,
  canvas,
  reports,
  compliance,
  costs,
  page,
  budgets,
  tagKeys,
  virtualTags,
  invoices,
  unitCostsCommand,
  exportCommand,
  exportsCommand,
  paging,
  seats,
  diff,
  posture,
  prices,
  prCheck,
  services,
  jit,
  leaks,
  vulns,
  scorecards,
  apps,
  sshFanout,
  config,
  deploy,
  tui,
  help,
] as const;

/** The command name the root help and its parse errors are told apart by. */
export const ROOT_NAME = "infrawrench";

export const root = Command.withHandler(
  Command.make(ROOT_NAME).pipe(Command.withSharedFlags(globalFlags)),
  () => home,
).pipe(
  Command.withDescription("Manage your infrastructure from the terminal"),
  Command.withSubcommands(subcommands),
  Command.provideEffect(CliSession, (flags) => makeSession(flags)),
);

/** Every first word (and alias) the root knows. */
export const commandNames: ReadonlySet<string> = new Set(
  subcommands.flatMap((command) =>
    command.alias === undefined ? [command.name] : [command.name, command.alias],
  ),
);
