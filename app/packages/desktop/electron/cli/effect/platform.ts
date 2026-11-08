// The Node services `effect/cli` asks for (`Command.Environment`), written
// against `process` and `node:readline` directly. The CLI takes no new
// runtime dependency, so there is no `@effect/platform-node` here: what the
// parser and help renderer actually use is small, and everything else fails
// loudly rather than half-working.
//
// - Stdio: argv, TTY probes and the three streams of this process.
// - Terminal: size from `process.stdout`, `display` to stdout, `readLine` for
//   a line of input, and `readInput`: key by key in raw mode, decoded by
//   `node:readline`'s keypress parser, which is what `./prompt.ts` (the
//   CLI's own prompts) reads. Resize events (`size`) die with a sentence:
//   nothing here follows them, the TUI listens to `process.stdout` itself.
// - Path: the posix implementation `effect` ships.
// - FileSystem: a no-op. `Flag.File`/`Flag.Path` checks would need it; a
//   command reads its files with `node:fs` (as `cli/` always has) and takes
//   the path as a plain `Flag.String`.
// - ChildProcessSpawner: refuses. Commands that run processes use
//   `node:child_process`, the way the desktop main process does elsewhere.
import readline from "node:readline";
import {
  type Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Queue,
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
      `${what} is not available in the infrawrench CLI's terminal layer (cli/effect/platform.ts).`,
    ),
  );

/** What `readline`'s keypress parser says about one key. */
interface Keypress {
  readonly name?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly shift?: boolean | undefined;
}

/**
 * Keys as they are pressed, until the scope closes: stdin in raw mode for the
 * duration (so nothing echoes and Ctrl-C arrives as a key, which the reader
 * decides about), restored to what it was afterwards, on every path.
 */
const readInput = Effect.acquireRelease(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    const onKeypress = (input: string | undefined, key: Keypress | undefined): void => {
      Queue.offerUnsafe(queue, {
        input: Option.fromUndefinedOr(input),
        key: {
          name: key?.name ?? input ?? "",
          ctrl: key?.ctrl === true,
          meta: key?.meta === true,
          shift: key?.shift === true,
        },
      });
    };
    stdin.on("keypress", onKeypress);
    const restore = (): void => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    };
    return { queue, restore };
  }),
  ({ queue, restore }) => Effect.sync(restore).pipe(Effect.andThen(Queue.shutdown(queue))),
).pipe(Effect.map(({ queue }): Queue.Dequeue<Terminal.UserInput, Cause.Done> => queue));

const terminal = Terminal.make({
  columns: Effect.sync(() => process.stdout.columns ?? 80),
  rows: Effect.sync(() => process.stdout.rows ?? 24),
  size: unsupported("Terminal.size"),
  readInput,
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
