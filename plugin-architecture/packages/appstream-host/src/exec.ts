/**
 * Running one command on the host, and the two shell fragments everything here
 * shares.
 *
 * Split out of `index.ts` so the preflight can use them without importing the
 * session code — the preflight runs *before* anything has been staged, and has
 * to work on a host where staging would fail.
 */

/**
 * The slice of ssh2's `Client` this package uses.
 *
 * Structural rather than the real type so a test can drive it with a fake, and
 * so neither app has to hand over a client wrapped in whatever it wraps it in.
 */
export interface SshExecutor {
  exec(command: string, callback: (err: Error | undefined, channel: ExecChannel) => void): unknown;
}

/** The subset of ssh2's `ClientChannel` used here. */
export interface ExecChannel {
  on(event: "data", handler: (chunk: Buffer) => void): unknown;
  on(event: "close", handler: (code?: number | null, signal?: string) => void): unknown;
  once(event: "error", handler: (err: Error) => void): unknown;
  stderr: {
    on(event: "data", handler: (chunk: Buffer) => void): unknown;
    /**
     * Streams emit `error` whether or not anyone is listening, and an
     * unhandled one is not an exception this code can catch — it takes the
     * process down. stderr gets its own because it is a separate stream.
     */
    once(event: "error", handler: (err: Error) => void): unknown;
  };
  write(chunk: Buffer | string): unknown;
  end(): unknown;
}

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "AppServerError";
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run a command, collecting its output. `stdin` is written and the pipe closed. */
export function execCommand(
  conn: SshExecutor,
  command: string,
  stdin?: Buffer,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, channel) => {
      if (err) {
        reject(err);
        return;
      }
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      channel.on("data", (chunk) => out.push(chunk));
      channel.stderr.on("data", (chunk) => errOut.push(chunk));
      channel.once("error", reject);
      channel.on("close", (code) => {
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(errOut).toString("utf8"),
          code: code ?? null,
        });
      });
      if (stdin) channel.write(stdin);
      channel.end();
    });
  });
}

/**
 * Run a command, handing each line to `onLine` as it arrives.
 *
 * A package install is the one thing here that takes long enough for silence
 * to read as a hang, and its output is the only evidence of what a mirror
 * actually did. Both streams are relayed, because apt says most of what
 * matters on stderr.
 */
export function execStreaming(
  conn: SshExecutor,
  command: string,
  onLine: (line: string) => void,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, channel) => {
      if (err) {
        reject(err);
        return;
      }
      // One buffer per stream: a partial line on stdout must not be completed
      // by the next chunk of stderr.
      let outRest = "";
      let errRest = "";
      const feed = (rest: string, chunk: Buffer): string => {
        const lines = (rest + chunk.toString("utf8")).split("\n");
        const tail = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLine(line.replace(/\r/g, ""));
        return tail;
      };
      channel.on("data", (chunk) => {
        outRest = feed(outRest, chunk);
      });
      channel.stderr.on("data", (chunk) => {
        errRest = feed(errRest, chunk);
      });
      channel.once("error", reject);
      channel.stderr.once("error", () => {
        /* losing the diagnostics stream is not worth failing the install for */
      });
      channel.on("close", (code) => {
        for (const rest of [outRest, errRest]) if (rest.trim()) onLine(rest.replace(/\r/g, ""));
        resolve(code ?? null);
      });
      channel.end();
    });
  });
}

/**
 * Where the binary is staged, best first.
 *
 * `/dev/shm` and `/run/user/<uid>` are tmpfs on every mainstream distribution,
 * so the bytes never reach a disk. `/tmp` is the fallback for hosts that have
 * neither — often a disk, which is why it is last, and why the file is unlinked
 * before the process starts either way.
 */
const STAGING_DIRS = ["/dev/shm", `/run/user/$(id -u)`, "$XDG_RUNTIME_DIR", "/tmp"] as const;

/**
 * Shell that picks the first staging directory that exists, is writable, and
 * permits execution — a hardened host may mount `/tmp` or `/dev/shm` `noexec`,
 * and finding that out by failing to exec is a much worse error message.
 */
export function pickStagingDirScript(): string {
  return STAGING_DIRS.map(
    (dir) =>
      `for d in ${dir}; do [ -n "$d" ] && [ -d "$d" ] && [ -w "$d" ] && ` +
      `t=$(mktemp "$d/.iw.XXXXXXXX" 2>/dev/null) && ` +
      // The only reliable test for noexec is to run something from it.
      `{ printf '#!/bin/sh\\nexit 0\\n' > "$t"; chmod 700 "$t"; ` +
      `if "$t" 2>/dev/null; then rm -f "$t"; echo "$d"; exit 0; fi; rm -f "$t"; }; done`,
  ).join("\n");
}

/** Single-quote a value for `sh`, closing and reopening around any quote. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
