// Every top-level command, by the word that names it, as a loader. The CLI
// is on the path of everyday git commands (`env pull` runs from git hooks),
// so a command line loads only the command modules it names: evaluating all
// of them, and everything they import, was most of a cold start. `run.ts`
// builds the root from what `loadCommands` returns.
//
// A new command is one entry here (its name, and each alias, as a key), plus
// its line in `../help.ts`. The keys are `commandNames` (`root.ts`), and
// `cli-effect.test.ts` checks each loader answers a command of that name.
import { help, tui } from "../commands/tui";
import { isStandaloneCli } from "../edition";

export const COMMAND_LOADERS = {
  login: () => import("../commands/auth").then((m) => m.login),
  logout: () => import("../commands/auth").then((m) => m.logout),
  whoami: () => import("../commands/auth").then((m) => m.whoami),
  orgs: () => import("../commands/orgs").then((m) => m.orgs),
  cli: () => import("../commands/cli-install").then((m) => m.cli),
  agents: () => import("../commands/agents").then((m) => m.agents),
  dns: () => import("../commands/dns").then((m) => m.dns),
  accounts: () => import("../commands/listing").then((m) => m.accounts),
  resources: () => import("../commands/listing").then((m) => m.resources),
  resource: () => import("../commands/listing").then((m) => m.resource),
  leases: () => import("../commands/leases").then((m) => m.leases),
  ownership: () => import("../commands/ownership").then((m) => m.ownership),
  "blast-radius": () => import("../commands/blast-radius").then((m) => m.blastRadius),
  oversized: () => import("../commands/oversized").then((m) => m.oversized),
  "github-issues": () => import("../commands/github-issues").then((m) => m.githubIssues),
  "idle-rules": () => import("../commands/idle-rules").then((m) => m.idleRules),
  incidents: () => import("../commands/incidents").then((m) => m.incidents),
  access: () => import("../commands/access").then((m) => m.access),
  expiring: () => import("../commands/expiring").then((m) => m.expiring),
  schedules: () => import("../commands/schedules").then((m) => m.schedules),
  credits: () => import("../commands/credits").then((m) => m.credits),
  runway: () => import("../commands/runway").then((m) => m.runway),
  "cost-visibility": () => import("../commands/cost-visibility").then((m) => m.costVisibility),
  "status-pages": () => import("../commands/status-pages").then((m) => m.statusPages),
  "declared-incidents": () =>
    import("../commands/declared-incidents").then((m) => m.declaredIncidents),
  issues: () => import("../commands/issues").then((m) => m.issues),
  estimate: () => import("../commands/estimate").then((m) => m.estimate),
  "migrate-estimate": () => import("../commands/migrate-estimate").then((m) => m.migrateEstimate),
  orphans: () => import("../commands/orphans").then((m) => m.orphans),
  offboard: () => import("../commands/offboard").then((m) => m.offboard),
  "extended-support": () => import("../commands/extended-support").then((m) => m.extendedSupport),
  probes: () => import("../commands/probes").then((m) => m.probes),
  heartbeats: () => import("../commands/heartbeats").then((m) => m.heartbeats),
  webhooks: () => import("../commands/webhooks").then((m) => m.webhooks),
  slos: () => import("../commands/slos").then((m) => m.slos),
  commitments: () => import("../commands/commitments").then((m) => m.commitments),
  hygiene: () => import("../commands/hygiene").then((m) => m.hygiene),
  carbon: () => import("../commands/carbon").then((m) => m.carbon),
  alerts: () => import("../commands/alerts").then((m) => m.alerts),
  routing: () => import("../commands/routing").then((m) => m.routing),
  changes: () => import("../commands/changes").then((m) => m.changes),
  moment: () => import("../commands/moment").then((m) => m.moment),
  metrics: () => import("../commands/metrics").then((m) => m.metrics),
  graph: () => import("../commands/graph").then((m) => m.graph),
  search: () => import("../commands/search").then((m) => m.search),
  starred: () => import("../commands/search").then((m) => m.starred),
  tags: () => import("../commands/tags").then((m) => m.tags),
  showback: () => import("../commands/tags").then((m) => m.showback),
  "k8s-network": () => import("../commands/k8s-network").then((m) => m.k8sNetwork),
  "ai-spend": () => import("../commands/ai-spend").then((m) => m.aiSpend),
  scenarios: () => import("../commands/scenarios").then((m) => m.scenarios),
  "billing-rules": () => import("../commands/billing-rules").then((m) => m.billingRules),
  savings: () => import("../commands/savings").then((m) => m.savings),
  dora: () => import("../commands/dora").then((m) => m.dora),
  currency: () => import("../commands/currency").then((m) => m.currencyCommand),
  "network-reports": () => import("../commands/network-reports").then((m) => m.networkReports),
  "k8s-efficiency": () => import("../commands/k8s-efficiency").then((m) => m.k8sEfficiency),
  "resource-reports": () => import("../commands/resource-reports").then((m) => m.resourceReports),
  recordings: () => import("../commands/recordings").then((m) => m.recordings),
  dashboards: () => import("../commands/dashboards").then((m) => m.dashboards),
  canvas: () => import("../commands/canvas").then((m) => m.canvas),
  canvases: () => import("../commands/canvas").then((m) => m.canvas),
  reports: () => import("../commands/reports").then((m) => m.reports),
  compliance: () => import("../commands/compliance").then((m) => m.compliance),
  costs: () => import("../commands/costs").then((m) => m.costs),
  page: () => import("../commands/push").then((m) => m.page),
  budgets: () => import("../commands/budgets").then((m) => m.budgets),
  "tag-keys": () => import("../commands/tag-keys").then((m) => m.tagKeys),
  "virtual-tags": () => import("../commands/virtual-tags").then((m) => m.virtualTags),
  invoices: () => import("../commands/invoices").then((m) => m.invoices),
  "unit-costs": () => import("../commands/unit-costs").then((m) => m.unitCostsCommand),
  export: () => import("../commands/export").then((m) => m.exportCommand),
  exports: () => import("../commands/exports").then((m) => m.exportsCommand),
  paging: () => import("../commands/paging").then((m) => m.paging),
  seats: () => import("../commands/seats").then((m) => m.seats),
  diff: () => import("../commands/diff").then((m) => m.diff),
  posture: () => import("../commands/posture").then((m) => m.posture),
  prices: () => import("../commands/prices").then((m) => m.prices),
  "pr-check": () => import("../commands/pr-check").then((m) => m.prCheck),
  env: () => import("../commands/env-files").then((m) => m.env),
  services: () => import("../commands/services").then((m) => m.services),
  jit: () => import("../commands/jit").then((m) => m.jit),
  leaks: () => import("../commands/leaks").then((m) => m.leaks),
  vulns: () => import("../commands/vulns").then((m) => m.vulns),
  vulnerabilities: () => import("../commands/vulns").then((m) => m.vulns),
  scorecards: () => import("../commands/scorecards").then((m) => m.scorecards),
  apps: () => import("../commands/apps").then((m) => m.apps),
  "ssh-fanout": () => import("../commands/ssh-fanout").then((m) => m.sshFanout),
  config: () => import("../commands/config").then((m) => m.config),
  // Static: `root.ts` imports their module for `home` anyway.
  tui: () => Promise.resolve(tui),
  help: () => Promise.resolve(help),
};

export type CommandName = keyof typeof COMMAND_LOADERS;

/** Any command a loader answers: the root's subcommand type. */
export type AnyCommand = Awaited<ReturnType<(typeof COMMAND_LOADERS)[CommandName]>>;

/**
 * In every tree. Their module is small (the TUI itself loads on use), and a
 * root with no subcommands at all would answer a typo with a different error
 * than "Unknown command".
 */
const ALWAYS: ReadonlyArray<CommandName> = ["help", "tui"];

const isCommandName = (word: string): word is CommandName =>
  Object.prototype.hasOwnProperty.call(COMMAND_LOADERS, word);

/**
 * The commands a command line may run: every token before `--` that names
 * one. Flag values are not told apart from words (that would mean knowing
 * every flag's arity before parsing), so `--type costs` loads `costs` too;
 * loading one module too many is harmless, while missing the real one would
 * turn the command into "Unknown command".
 */
export function commandWordsIn(argv: ReadonlyArray<string>): ReadonlyArray<CommandName> {
  const end = argv.indexOf("--");
  const named = new Set<CommandName>(ALWAYS);
  for (const token of end === -1 ? argv : argv.slice(0, end)) {
    if (isCommandName(token)) named.add(token);
  }
  // Registry order, so the tree is the same whatever order the words came in.
  return (Object.keys(COMMAND_LOADERS) as CommandName[]).filter((name) => named.has(name));
}

/**
 * Commands that drive the desktop app itself, so the standalone CLI
 * (`../edition.ts`) leaves them out: `cli` installs the shim that launches
 * the app, and `apps` streams a Linux application into one of its tabs.
 * `run.ts` answers either name with `desktopOnlyCommand` there.
 */
export const DESKTOP_ONLY_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  "cli",
  "apps",
]);

/** Whether this build of the CLI offers `name` (`DESKTOP_ONLY_COMMANDS`). */
export const isDesktopOnlyHere = (name: string): boolean =>
  isStandaloneCli() && isCommandName(name) && DESKTOP_ONLY_COMMANDS.has(name);

/** Load the commands {@link commandWordsIn} names; an alias and its command once. */
export async function loadCommands(argv: ReadonlyArray<string>): Promise<AnyCommand[]> {
  const names = commandWordsIn(argv).filter((name) => !isDesktopOnlyHere(name));
  const loaded = await Promise.all(names.map((name) => COMMAND_LOADERS[name]()));
  return [...new Set(loaded)];
}
