/**
 * A scripted ssh2 client, shared by the session tests and the preflight tests.
 *
 * Lives beside them rather than in `src/` because nothing outside the tests
 * should be tempted to depend on it.
 */
import type { ExecChannel, SshExecutor } from "../index.js";

export interface Reply {
  match: RegExp;
  stdout?: string;
  stderr?: string;
  code?: number;
  fail?: string;
  /** Leave the channel open, as a long-lived session does. */
  hold?: boolean;
}

/** A scripted ssh2 client: each command is matched against a reply table. */
export class FakeSsh implements SshExecutor {
  commands: string[] = [];
  stdinByCommand = new Map<string, Buffer>();
  /** Channels handed out for commands whose reply says `hold`. */
  open: Array<{ command: string; channel: FakeChannel }> = [];
  #replies: Reply[];

  constructor(replies: Reply[]) {
    this.#replies = replies;
  }

  exec(command: string, callback: (err: Error | undefined, channel: ExecChannel) => void): void {
    this.commands.push(command);
    const reply = this.#replies.find((candidate) => candidate.match.test(command));
    if (reply?.fail) {
      callback(new Error(reply.fail), undefined as unknown as ExecChannel);
      return;
    }

    const channel = new FakeChannel((stdin) => {
      if (stdin) this.stdinByCommand.set(command, stdin);
    });
    if (reply?.hold) this.open.push({ command, channel });
    callback(undefined, channel);

    if (!reply?.hold) {
      queueMicrotask(() => {
        channel.emitData(reply?.stdout ?? "");
        channel.emitStderr(reply?.stderr ?? "");
        channel.emitClose(reply?.code ?? 0);
      });
    }
  }

  /** The command that staged the binary, if one ran. */
  stagingCommand(): string | undefined {
    return this.commands.find((command) => command.includes("gunzip"));
  }
}

export class FakeChannel implements ExecChannel {
  #data: Array<(chunk: Buffer) => void> = [];
  #stderr: Array<(chunk: Buffer) => void> = [];
  #close: Array<(code?: number | null) => void> = [];
  written: Buffer[] = [];
  ended = false;

  constructor(private readonly onEnd: (stdin: Buffer | undefined) => void) {}

  stderr: ExecChannel["stderr"] = {
    on: (_event: "data", handler: (chunk: Buffer) => void) => {
      this.#stderr.push(handler);
      return this;
    },
    once: (_event: "error", handler: (err: Error) => void) => {
      this.stderrErrorHandlers.push(handler);
      return this;
    },
  };

  /** Error listeners, so a test can assert nothing is left unhandled. */
  errorHandlers: Array<(err: Error) => void> = [];
  stderrErrorHandlers: Array<(err: Error) => void> = [];
  /** Set when the channel refuses further writes, as a dead one would. */
  broken = false;

  on(event: "data" | "close", handler: never): this {
    if (event === "data") this.#data.push(handler as (chunk: Buffer) => void);
    else this.#close.push(handler as (code?: number | null) => void);
    return this;
  }
  once(_event: "error", handler: (err: Error) => void): this {
    this.errorHandlers.push(handler);
    return this;
  }
  write(chunk: Buffer | string): this {
    if (this.broken) throw new Error("write after end");
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return this;
  }
  end(): this {
    this.ended = true;
    this.onEnd(this.written.length ? Buffer.concat(this.written) : undefined);
    return this;
  }

  emitData(text: string | Buffer): void {
    const chunk = Buffer.isBuffer(text) ? text : Buffer.from(text);
    for (const handler of this.#data) handler(chunk);
  }
  emitStderr(text: string): void {
    if (!text) return;
    for (const handler of this.#stderr) handler(Buffer.from(text));
  }
  emitClose(code: number | null): void {
    for (const handler of this.#close) handler(code);
  }
  emitError(message: string): void {
    for (const handler of this.errorHandlers) handler(new Error(message));
  }
}

/**
 * Undo the outer `sh -c '…'` quoting, so assertions read the script the host
 * will actually run rather than its escaped form.
 */
export function innerScript(command: string): string {
  const start = command.indexOf("'");
  return command.slice(start + 1, command.lastIndexOf("'")).replaceAll(`'\\''`, "'");
}
