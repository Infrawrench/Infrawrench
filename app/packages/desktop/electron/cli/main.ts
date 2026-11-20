// Headless CLI runner. Reached via the bootstrap in electron/index.ts when
// the process was launched with --cli (normally through the `infrawrench`
// shell shim). Runs the full Electron app object (safeStorage needs it for
// the master key) but never opens a window, registers a protocol, or keeps
// the single-instance lock.
//
// Every command line goes through `effect/cli` (`effect/root.ts`, run by
// `effect/run.ts`); this file only makes the Electron process behave like a
// terminal program and settles what every command needs before it runs.
import { app } from "electron";
import { wireDbGetter, setDatabaseReadOnly } from "../db";
import { setRequireExistingEncryptionKey, UserFacingError } from "../main-utils";
import { setTokenStoreReadOnly } from "../cloud-tokens";
import { CliError } from "./context";
import { setColorEnabled, printErr, c } from "./output";
import { runEffectCli } from "./effect/run";
import { markPhase, reportTiming } from "../startup-timing";

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
 * Everything a command needs before it runs. Order is load-bearing: see
 * detectGuiRunning(). Ready first, probe second.
 */
async function bootstrap(): Promise<boolean> {
  await app.whenReady();
  markPhase("app ready");
  const guiRunning = detectGuiRunning();
  markPhase("lock probe");

  wireDbGetter();
  setDatabaseReadOnly(guiRunning);
  setTokenStoreReadOnly(guiRunning);
  // The GUI owns first-run key creation. A terminal session that can't reach
  // the keychain must fail loudly rather than mint a key that orphans every
  // stored credential.
  setRequireExistingEncryptionKey(true);
  return guiRunning;
}

/**
 * `--no-color` anywhere among the flags (not past `--`, where it belongs to
 * a remote command). Read before parsing so help and parse errors are
 * already uncoloured; the session applies the parsed value again.
 */
function noColorRequested(argv: ReadonlyArray<string>): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--no-color");
}

/**
 * The status the process exits with: the command's own, or else whatever
 * code underneath it left in `process.exitCode`. Node exits with that field
 * when it runs out of work; Electron's `app.exit(code)` exits with its
 * argument and never reads it, so a failure signalled the Node way would
 * otherwise reach the shell as success.
 */
function cliExitStatus(commandStatus: number): number {
  if (commandStatus !== 0) return commandStatus;
  const pending = Number(process.exitCode ?? 0);
  return Number.isInteger(pending) ? pending : 1;
}

/**
 * Resolves once everything written to `stream` has left the process.
 * `app.exit` ends the process at once, without the flush Node does on its
 * own way out, and writes to a pipe are asynchronous on macOS: output past
 * the pipe's 64 KiB buffer that a slower reader had not taken yet was lost.
 * An empty write's callback runs after every write queued before it.
 */
function drained(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0 || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => stream.write("", () => resolve()));
}

export async function runCli(): Promise<void> {
  markPhase("cli modules loaded");
  installTerminalGuards();
  // No Dock icon and no GPU were settled in `../index.ts`, before this
  // module (and the app's launch) got this far.

  const argv = process.argv.slice(process.argv.indexOf("--cli") + 1);
  setColorEnabled(
    !noColorRequested(argv) && process.stdout.isTTY === true && !process.env.NO_COLOR,
  );

  let exitCode: number;
  try {
    const guiRunning = await bootstrap();
    exitCode = await runEffectCli(argv, { version: app.getVersion(), guiRunning });
  } catch (e) {
    // Only the bootstrap can get here (`runEffectCli` answers every outcome
    // with an exit code). A locked keychain is one line, a bug its stack.
    if (e instanceof CliError || e instanceof UserFacingError) {
      printErr(c.red(e.message));
      exitCode = e instanceof CliError ? e.exitCode : 1;
    } else {
      printErr(c.red(e instanceof Error ? (e.stack ?? e.message) : String(e)));
      exitCode = 1;
    }
  }
  markPhase("command done");
  reportTiming();
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  app.exit(cliExitStatus(exitCode));
}
