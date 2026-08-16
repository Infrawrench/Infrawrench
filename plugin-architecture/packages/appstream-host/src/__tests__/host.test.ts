import { describe, expect, it, vi } from "vitest";

import {
  AppServerError,
  detectArch,
  listApps,
  startAppServer,
  type ExecChannel,
  type SshExecutor,
} from "../index.js";

interface Reply {
  match: RegExp;
  stdout?: string;
  stderr?: string;
  code?: number;
  fail?: string;
  /** Leave the channel open, as a long-lived session does. */
  hold?: boolean;
}

/** A scripted ssh2 client: each command is matched against a reply table. */
class FakeSsh implements SshExecutor {
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

class FakeChannel implements ExecChannel {
  #data: Array<(chunk: Buffer) => void> = [];
  #stderr: Array<(chunk: Buffer) => void> = [];
  #close: Array<(code?: number | null) => void> = [];
  written: Buffer[] = [];
  ended = false;

  constructor(private readonly onEnd: (stdin: Buffer | undefined) => void) {}

  stderr = {
    on: (_event: "data", handler: (chunk: Buffer) => void) => {
      this.#stderr.push(handler);
      return this;
    },
  };

  on(event: "data" | "close", handler: never): this {
    if (event === "data") this.#data.push(handler as (chunk: Buffer) => void);
    else this.#close.push(handler as (code?: number | null) => void);
    return this;
  }
  once(_event: "error", _handler: (err: Error) => void): this {
    return this;
  }
  write(chunk: Buffer | string): this {
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
}

/**
 * Undo the outer `sh -c '…'` quoting, so assertions read the script the host
 * will actually run rather than its escaped form.
 */
function innerScript(command: string): string {
  const start = command.indexOf("'");
  return command.slice(start + 1, command.lastIndexOf("'")).replaceAll(`'\\''`, "'");
}

const gz = Buffer.from("gzipped-binary");
const source = { binaryForArch: async () => gz };

/** A host that stages successfully and then holds the session channel open. */
const readyHost = () =>
  new FakeSsh([
    { match: /uname/, stdout: "x86_64" },
    { match: /gunzip/, stdout: "/dev/shm/.iw.abcd1234" },
    { match: /proc\/self\/fd/, hold: true },
  ]);

describe("detectArch", () => {
  it("normalises what uname reports", async () => {
    for (const [reported, expected] of [
      ["x86_64", "x86_64"],
      ["amd64", "x86_64"],
      ["aarch64", "aarch64"],
      ["arm64", "aarch64"],
      ["  x86_64\n", "x86_64"],
    ] as const) {
      const ssh = new FakeSsh([{ match: /uname/, stdout: reported }]);
      expect(await detectArch(ssh)).toBe(expected);
    }
  });

  it("names the architecture it cannot serve", async () => {
    const ssh = new FakeSsh([{ match: /uname/, stdout: "riscv64" }]);
    await expect(detectArch(ssh)).rejects.toThrow(/riscv64/);
  });

  it("reports a failing uname rather than guessing", async () => {
    const ssh = new FakeSsh([{ match: /uname/, stderr: "permission denied", code: 126 }]);
    await expect(detectArch(ssh)).rejects.toThrow(AppServerError);
  });
});

describe("staging", () => {
  it("writes to RAM, never to a fixed path", async () => {
    const ssh = readyHost();
    await startAppServer(ssh, { ...source, sessionId: "s" });

    const staging = ssh.stagingCommand()!;
    expect(staging).toMatch(/dev\/shm/);
    expect(staging).toMatch(/run\/user/);
    expect(staging).toMatch(/mktemp/);
    // Nothing predictable, nothing versioned, nothing a second session finds.
    expect(staging).not.toMatch(/\.cache/);
  });

  it("checks a staging directory can actually execute before using it", async () => {
    // A hardened host mounts /tmp and /dev/shm noexec. Discovering that by
    // failing to exec gives a far worse error than skipping the directory.
    const ssh = readyHost();
    await startAppServer(ssh, { ...source, sessionId: "s" });
    expect(innerScript(ssh.stagingCommand()!)).toMatch(/printf '#!\/bin\/sh/);
  });

  it("arms a watchdog so a client that dies stages nothing permanent", async () => {
    const ssh = readyHost();
    await startAppServer(ssh, { ...source, sessionId: "s" });
    expect(ssh.stagingCommand()).toMatch(/sleep 60; rm -f/);
  });

  it("sends the binary in over stdin", async () => {
    const ssh = readyHost();
    await startAppServer(ssh, { ...source, sessionId: "s" });
    expect(ssh.stdinByCommand.get(ssh.stagingCommand()!)).toEqual(gz);
  });

  it("uploads again for every session rather than caching on the host", async () => {
    // The trade is about a megabyte per session against leaving an executable
    // on someone else's machine.
    const binaryForArch = vi.fn(async () => gz);
    for (let i = 0; i < 2; i++) {
      await startAppServer(readyHost(), { binaryForArch, sessionId: `s${i}` });
    }
    expect(binaryForArch).toHaveBeenCalledTimes(2);
  });

  it("surfaces the host's own error when staging fails", async () => {
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /gunzip/, stderr: "sh: gunzip: not found", code: 127 },
    ]);
    await expect(startAppServer(ssh, { ...source, sessionId: "s" })).rejects.toThrow(
      /gunzip: not found/,
    );
  });

  it("fails when no directory is both writable and exec-capable", async () => {
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /gunzip/, stderr: "no writable, exec-capable directory for staging", code: 1 },
    ]);
    await expect(startAppServer(ssh, { ...source, sessionId: "s" })).rejects.toThrow(
      /exec-capable/,
    );
  });

  it("refuses a staging reply that is not a path", async () => {
    // A shell profile that prints a banner would otherwise have us exec ""
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /gunzip/, stdout: "Welcome to Ubuntu!" },
    ]);
    await expect(startAppServer(ssh, { ...source, sessionId: "s" })).rejects.toThrow(
      /could not stage/,
    );
  });
});

describe("startAppServer", () => {
  it("unlinks the binary before running it, and runs it through the open descriptor", async () => {
    const ssh = readyHost();
    await startAppServer(ssh, { ...source, sessionId: "s" });

    const run = ssh.commands.find((command) => command.includes("proc/self/fd"))!;
    // Order matters: open, then delete, then exec. Deleting after the exec
    // would leave the file behind whenever the exec fails.
    expect(run.indexOf("exec 3<")).toBeLessThan(run.indexOf("rm -f"));
    expect(run.indexOf("rm -f")).toBeLessThan(run.indexOf("exec /proc/self/fd/3"));
    expect(run).toContain("/dev/shm/.iw.abcd1234");
  });

  it("execs rather than forking, so the channel owns the process", async () => {
    const ssh = readyHost();
    await startAppServer(ssh, { ...source, sessionId: "s" });
    expect(ssh.commands.at(-1)).toMatch(/exec \/proc\/self\/fd\/3 --serve/);
  });

  it("passes the session's own socket namespace and limits", async () => {
    const ssh = readyHost();
    await startAppServer(ssh, {
      ...source,
      sessionId: "sess-1",
      idleTimeoutSecs: 60,
      iconSize: 32,
    });
    const run = innerScript(ssh.commands.at(-1)!);
    expect(run).toMatch(/--session-id 'sess-1'/);
    expect(run).toMatch(/--idle-timeout 60/);
    expect(run).toMatch(/--icon-size 32/);
  });

  it("quotes a session id that would otherwise run a command", async () => {
    const ssh = readyHost();
    await startAppServer(ssh, { ...source, sessionId: "a'; rm -rf ~; echo '" });
    // It survives as a single argument: every quote in it is closed and
    // reopened, so the shell never sees `rm` as a command of its own.
    const run = innerScript(ssh.commands.at(-1)!);
    expect(run).toContain(`--session-id 'a'\\''; rm -rf ~; echo '\\'''`);
  });

  it("carries frames in both directions", async () => {
    const ssh = readyHost();
    const session = await startAppServer(ssh, { ...source, sessionId: "s" });
    const received: Buffer[] = [];
    session.onData((chunk) => received.push(chunk));

    const channel = ssh.open[0]!.channel;
    channel.emitData(Buffer.from([1, 2, 3]));
    session.write(Buffer.from([9]));

    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3]));
    expect(channel.written.at(-1)).toEqual(Buffer.from([9]));
  });

  it("reports the host's stderr a line at a time", async () => {
    // "the app exited immediately" is nearly always a missing library, and the
    // real message is on stderr.
    const ssh = readyHost();
    const lines: string[] = [];
    await startAppServer(ssh, { ...source, sessionId: "s", onStderr: (line) => lines.push(line) });

    const channel = ssh.open[0]!.channel;
    channel.emitStderr("iwappd: launch failed: libgtk-4.so.1: cannot open\npartial line");
    expect(lines).toEqual(["iwappd: launch failed: libgtk-4.so.1: cannot open"]);

    channel.emitStderr(" continues\n");
    expect(lines).toEqual([
      "iwappd: launch failed: libgtk-4.so.1: cannot open",
      "partial line continues",
    ]);
  });

  it("reports the channel closing", async () => {
    const ssh = readyHost();
    const session = await startAppServer(ssh, { ...source, sessionId: "s" });
    const codes: Array<number | null> = [];
    session.onClose((code) => codes.push(code));
    ssh.open[0]!.channel.emitClose(3);
    expect(codes).toEqual([3]);
  });

  it("reports progress through to ready", async () => {
    const stages: string[] = [];
    await startAppServer(readyHost(), {
      ...source,
      sessionId: "s",
      onProgress: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(["detecting", "uploading", "starting", "ready"]);
  });
});

describe("listApps", () => {
  const listingHost = (stdout: string, code = 0) =>
    new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /list-apps/, stdout, code },
    ]);

  it("stages, runs and deletes in a single exec", async () => {
    // No session, no stdin of its own — so it does not need the two channels
    // the server does.
    const apps = [{ id: "firefox.desktop", name: "Firefox" }];
    const ssh = listingHost(JSON.stringify(apps));

    expect(await listApps(ssh, { ...source, iconSize: 32 })).toEqual(apps);
    const command = ssh.commands.at(-1)!;
    expect(command).toMatch(/gunzip/);
    expect(command).toMatch(/rm -f/);
    expect(command).toMatch(/--list-apps --json --icon-size 32/);
  });

  it("reads the last line, so a login banner does not become the answer", async () => {
    const ssh = listingHost('Welcome to Ubuntu!\nLast login: today\n[{"id":"a","name":"A"}]');
    expect(await listApps(ssh, source)).toEqual([{ id: "a", name: "A" }]);
  });

  it("refuses output that is not an application list", async () => {
    await expect(listApps(listingHost("not json at all"), source)).rejects.toThrow(
      /not an application list/,
    );
  });

  it("surfaces a failure from the host", async () => {
    await expect(listApps(listingHost("", 127), source)).rejects.toThrow(AppServerError);
  });
});
