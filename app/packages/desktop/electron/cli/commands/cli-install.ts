// `infrawrench cli install|uninstall|status`: manage the shell shim itself.
// Bare `infrawrench cli` is `status`.
import { Effect } from "effect";
import { Command } from "effect/cli";
import { ShellCommand } from "../../shell-command";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { c } from "../output";

/** A refusal (an unrelated binary in the way, no writable directory) is one sentence. */
const refused = Effect.mapError(
  (e: { readonly message: string }) => new CliFailure({ message: e.message }),
);

const status = Effect.fn("cli.status")(function* () {
  const session = yield* CliSession;
  const shell = yield* ShellCommand;
  const result = yield* shell.status;
  if (session.output === "json") return yield* Print.json(result);
  if (!result.installed || !result.path) {
    return yield* Print.line("Shell command is not installed. Run `infrawrench cli install`.");
  }
  yield* Print.line(
    `Installed at ${c.bold(result.path)}${result.stale ? c.yellow(" (points at a different app build; reinstall)") : ""}`,
  );
});

const install = Command.make(
  "install",
  {},
  Effect.fn("cli.install")(function* () {
    const session = yield* CliSession;
    const shell = yield* ShellCommand;
    const result = yield* shell.install.pipe(refused);
    if (session.output === "json") return yield* Print.json(result);
    yield* Print.line(`${c.green("✓")} Installed ${c.bold(result.path)}`);
    if (result.note) yield* Print.line(c.yellow(result.note));
  }),
).pipe(Command.withDescription("Put the `infrawrench` command on your PATH"));

const uninstall = Command.make(
  "uninstall",
  {},
  Effect.fn("cli.uninstall")(function* () {
    const session = yield* CliSession;
    const shell = yield* ShellCommand;
    const removed = yield* shell.uninstall.pipe(refused);
    if (session.output === "json") return yield* Print.json({ removed });
    yield* Print.line(
      removed ? `${c.green("✓")} Removed ${removed}` : "Shell command is not installed.",
    );
  }),
).pipe(Command.withDescription("Remove the shell command"));

export const cli = Command.make("cli", {}, status).pipe(
  Command.withDescription("Install, remove or check this shell command (bare: status)"),
  Command.withSubcommands([
    install,
    uninstall,
    Command.make("status", {}, status).pipe(
      Command.withDescription("Whether the shell command is installed, and where"),
    ),
  ]),
  Command.provide(ShellCommand.layer),
);
