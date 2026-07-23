// `infrawrench cli install|uninstall|status` — manage the shell shim itself.
import {
  getShellCommandStatus,
  installShellCommand,
  uninstallShellCommand,
} from "../../shell-command";
import { CliError, type CliContext } from "../context";
import { c, printJson, println } from "../output";

export async function cmdCli(ctx: CliContext, action: string | undefined): Promise<void> {
  switch (action) {
    case "install": {
      const result = await installShellCommand();
      if (ctx.flags.output === "json") {
        printJson(result);
        return;
      }
      println(`${c.green("✓")} Installed ${c.bold(result.path)}`);
      if (result.note) println(c.yellow(result.note));
      return;
    }
    case "uninstall": {
      const removed = await uninstallShellCommand();
      if (ctx.flags.output === "json") {
        printJson({ removed });
        return;
      }
      println(removed ? `${c.green("✓")} Removed ${removed}` : "Shell command is not installed.");
      return;
    }
    case "status":
    case undefined: {
      const status = getShellCommandStatus();
      if (ctx.flags.output === "json") {
        printJson(status);
        return;
      }
      if (!status.installed) {
        println("Shell command is not installed. Run `infrawrench cli install`.");
      } else {
        println(
          `Installed at ${c.bold(status.path!)}${status.stale ? c.yellow(" (points at a different app build — reinstall)") : ""}`,
        );
      }
      return;
    }
    default:
      throw new CliError(
        `Unknown subcommand "cli ${action}" — use install, uninstall, or status.`,
        2,
      );
  }
}
