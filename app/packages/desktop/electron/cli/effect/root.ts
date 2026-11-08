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
import { cli } from "../commands/cli-install";
import { orgs } from "../commands/orgs";
import { CliSession, globalFlags, makeSession } from "./session";

const subcommands = [login, logout, whoami, orgs, cli] as const;

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
