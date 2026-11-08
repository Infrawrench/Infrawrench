// The `infrawrench` root command: the global flags as shared flags (so they
// parse before or after the subcommand, `--org x` and `--org=x` alike) and
// every command migrated to `effect/cli` so far. `runCli` sends a command
// here when its name is in `migratedCommands`; anything else still takes the
// legacy switch in `../main.ts`.
//
// Migrating a command adds it to `subcommands`; nothing else in this file
// changes. The root turns the parsed flags into the `CliSession` every
// handler reads, after help and version have had their turn.
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
import { hygiene } from "../commands/hygiene";
import { routing } from "../commands/routing";
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
] as const;

export const root = Command.make("infrawrench").pipe(
  Command.withDescription("Manage your infrastructure from the terminal"),
  Command.withSharedFlags(globalFlags),
  Command.withSubcommands(subcommands),
  Command.provideEffect(CliSession, (flags) => makeSession(flags)),
);

/** First words (and their aliases) that `runCli` hands to {@link root}. */
export const migratedCommands: ReadonlySet<string> = new Set(
  subcommands.flatMap((command) =>
    command.alias === undefined ? [command.name] : [command.name, command.alias],
  ),
);
