// The `infrawrench` root command: the global flags as shared flags (so they
// parse before or after the subcommand, `--org x` and `--org=x` alike), every
// command, and a handler of its own for bare `infrawrench` (the TUI at a
// terminal, the root help elsewhere). `runCli` hands every command line here.
//
// The commands come from `commands.ts`, loaded per command line: the tree a
// line is parsed against holds only the commands it names (plus `help` and
// `tui`). The root turns the parsed flags into the `CliSession` every
// handler reads, after help and version have had their turn.
import { Command } from "effect/cli";
import { home } from "../commands/tui";
import { type AnyCommand, COMMAND_LOADERS } from "./commands";
import { CliSession, globalFlags, makeSession } from "./session";

/** The command name the root help and its parse errors are told apart by. */
export const ROOT_NAME = "infrawrench";

/** The root over `subcommands` (`loadCommands(argv)`). */
export const makeRoot = (subcommands: ReadonlyArray<AnyCommand>) =>
  Command.withHandler(
    Command.make(ROOT_NAME).pipe(Command.withSharedFlags(globalFlags)),
    () => home,
  ).pipe(
    Command.withDescription("Manage your infrastructure from the terminal"),
    Command.withSubcommands(subcommands),
    Command.provideEffect(CliSession, (flags) => makeSession(flags)),
  );

/** Every first word (and alias) the root knows. */
export const commandNames: ReadonlySet<string> = new Set(Object.keys(COMMAND_LOADERS));
