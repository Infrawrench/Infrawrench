/**
 * Handing `pull` and `check` to the desktop app's CLI (`infrawrench env ...`)
 * when this package has no API key but the person has the desktop app, which
 * is signed in with their own account. Same flags, same wording; the desktop
 * CLI boots Electron, so it is the slow path, and it says so once on stderr.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ParsedArgs } from "./args";
import type { Io } from "./io";

export const DESKTOP_CLI = "infrawrench";

/** The executable `name` on PATH, or null. */
export function findOnPath(name: string, io: Pick<Io, "env" | "platform">): string | null {
  const path = io.env.PATH ?? io.env.Path ?? "";
  const extensions =
    io.platform === "win32"
      ? (io.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try {
        const stat = statSync(candidate);
        if (!stat.isFile()) continue;
        // The mode's execute bits rather than access(X_OK): some sandboxes
        // (Infrawrench CI's among them) answer X_OK for any file but report
        // real modes through stat.
        if (io.platform !== "win32" && (stat.mode & 0o111) === 0) continue;
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

export type Route =
  | { readonly kind: "self" }
  | { readonly kind: "delegate"; readonly executable: string }
  | { readonly kind: "none" };

/** Who runs a cloud command: this package (a key), the desktop CLI, or nobody. */
export function route(hasCredentials: boolean, desktopCli: string | null): Route {
  if (hasCredentials) return { kind: "self" };
  if (desktopCli !== null) return { kind: "delegate", executable: desktopCli };
  return { kind: "none" };
}

/** The desktop CLI's argv for the same command: `env <command>` and the flags as given. */
export function delegatedArgv(command: "pull" | "check", args: ParsedArgs): string[] {
  const argv = ["env", command];
  const push = (flag: string, value: string | null) => {
    if (value !== null) argv.push(flag, value);
  };
  push("--env", args.env);
  push("--file", args.file);
  push("--out", args.out);
  for (const [key, value] of Object.entries(args.vars)) argv.push("--var", `${key}=${value}`);
  if (args.stdout) argv.push("--stdout");
  if (args.force) argv.push("--force");
  if (args.quiet) argv.push("--quiet");
  if (args.json) argv.push("--json");
  push("--org", args.org);
  if (args.noColor) argv.push("--no-color");
  return argv;
}

/** Run the desktop CLI with this process's terminal; resolves with its exit code. */
export function runDelegated(executable: string, argv: readonly string[], io: Io): Promise<number> {
  return new Promise((done) => {
    const child = spawn(executable, [...argv], {
      cwd: io.cwd,
      env: io.env as NodeJS.ProcessEnv,
      stdio: "inherit",
      windowsHide: true,
      // A .cmd shim on Windows only runs through the shell.
      shell: io.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
    });
    child.on("error", (error) => {
      io.err(`infraenv: could not run ${executable}: ${error.message}\n`);
      done(1);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}
