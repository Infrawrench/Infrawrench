// The Node services `effect/cli` asks for (`Command.Environment`), written
// against `process` and `node:readline` directly. The CLI takes no new
// runtime dependency, so there is no `@effect/platform-node` here: what the
// parser and help renderer actually use is small, and everything else fails
// loudly rather than half-working.
//
// - Stdio: argv, TTY probes and the three streams of this process.
// - Terminal: size from `process.stdout`, `display` to stdout, `readLine` for
//   prompts. Key-by-key input (`readInput`, `size` as a stream) is what
//   `effect/cli`'s interactive `Prompt`s need; the CLI prompts through
//   `cli/prompt.ts` instead, so those die with a sentence saying so.
// - Path: the posix implementation `effect` ships.
// - FileSystem: a no-op. `Flag.File`/`Flag.Path` checks would need it; a
//   command reads its files with `node:fs` (as `cli/` always has) and takes
//   the path as a plain `Flag.String`.
// - ChildProcessSpawner: refuses. Commands that run processes use
//   `node:child_process`, the way the desktop main process does elsewhere.
import readline from "node:readline";
import {
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Sink,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import { ChildProcessSpawner } from "effect/process";

const cliArgs = (): ReadonlyArray<string> => process.argv.slice(process.argv.indexOf("--cli") + 1);

const write = (stream: NodeJS.WriteStream) =>
  Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => void stream.write(chunk)));

const stdio = Stdio.make({
  args: Effect.sync(cliArgs),
  stdinIsTerminal: Effect.sync(() => process.stdin.isTTY === true),
  stdoutIsTerminal: Effect.sync(() => process.stdout.isTTY === true),
  stderrIsTerminal: Effect.sync(() => process.stderr.isTTY === true),
  stdout: () => write(process.stdout),
  stderr: () => write(process.stderr),
  // Suspended: touching `process.stdin` creates the stream, which nothing
  // should do unless a command actually reads it.
  stdin: Stream.suspend(() =>
    Stream.fromAsyncIterable(process.stdin, (cause) =>
      PlatformError.systemError({
        _tag: "Unknown",
        module: "Stdio",
        method: "stdin",
        description: "Reading standard input failed",
        cause,
      }),
    ),
  ),
});

/** One line from stdin; end of input (Ctrl-D) or Ctrl-C is a `QuitError`. */
const readLine = Effect.callback<string, Terminal.QuitError>((resume) => {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let answered = false;
  rl.once("line", (line) => {
    answered = true;
    rl.close();
    resume(Effect.succeed(line));
  });
  rl.once("SIGINT", () => rl.close());
  rl.once("close", () => {
    if (!answered) resume(Effect.fail(new Terminal.QuitError()));
  });
  return Effect.sync(() => rl.close());
});

const unsupported = (what: string) =>
  Effect.die(
    new Error(
      `${what} is not available in the infrawrench CLI's terminal layer (cli/effect/platform.ts); prompt through cli/prompt.ts.`,
    ),
  );

const terminal = Terminal.make({
  columns: Effect.sync(() => process.stdout.columns ?? 80),
  rows: Effect.sync(() => process.stdout.rows ?? 24),
  size: unsupported("Terminal.size"),
  readInput: unsupported("Terminal.readInput"),
  readLine,
  display: (text) => Effect.sync(() => void process.stdout.write(text)),
});

const spawner = ChildProcessSpawner.make(() =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcessSpawner",
      method: "spawn",
      description:
        "The infrawrench CLI does not spawn processes through effect/process; use node:child_process in the command.",
    }),
  ),
);

/** Everything `Command.runWith` needs, over this Node process. */
export const CliPlatform = Layer.mergeAll(
  Layer.succeed(Stdio.Stdio)(stdio),
  Layer.succeed(Terminal.Terminal)(terminal),
  Path.layer,
  FileSystem.layerNoop({}),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner),
);
