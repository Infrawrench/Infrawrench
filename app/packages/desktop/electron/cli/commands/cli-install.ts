// `infrawrench cli install|uninstall|status`: manage the shell shim itself.
import { Effect } from "effect";
import { ShellCommand } from "../../shell-command";
import { CliError, type CliContext } from "../context";
import { c, printJson, println } from "../output";

/** Run one `ShellCommand` operation; a refusal rejects with its sentence, which the CLI prints. */
const shellCommand = <A, E>(f: (service: ShellCommand["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(ShellCommand.use(f).pipe(Effect.provide(ShellCommand.layer)));

export async function cmdCli(ctx: CliContext, action: string | undefined): Promise<void> {
  switch (action) {
    case "install": {
      const result = await shellCommand((s) => s.install);
      if (ctx.flags.output === "json") {
        printJson(result);
        return;
      }
      println(`${c.green("✓")} Installed ${c.bold(result.path)}`);
      if (result.note) println(c.yellow(result.note));
      return;
    }
    case "uninstall": {
      const removed = await shellCommand((s) => s.uninstall);
      if (ctx.flags.output === "json") {
        printJson({ removed });
        return;
      }
      println(removed ? `${c.green("✓")} Removed ${removed}` : "Shell command is not installed.");
      return;
    }
    case "status":
    case undefined: {
      const status = await shellCommand((s) => s.status);
      if (ctx.flags.output === "json") {
        printJson(status);
        return;
      }
      if (!status.installed) {
        println("Shell command is not installed. Run `infrawrench cli install`.");
      } else {
        println(
          `Installed at ${c.bold(status.path!)}${status.stale ? c.yellow(" (points at a different app build; reinstall)") : ""}`,
        );
      }
      return;
    }
    default:
      throw new CliError(
        `Unknown subcommand "cli ${action}": use install, uninstall, or status.`,
        2,
      );
  }
}
