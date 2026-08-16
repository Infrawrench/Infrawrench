import { describe, expect, it, vi } from "vitest";

import {
  AppServerError,
  detectArch,
  ensureAppServer,
  listApps,
  remoteBinaryPath,
  startAppServer,
  type ExecChannel,
  type SshExecutor,
} from "../index.js";

/** A scripted ssh2 client: each command is matched against a reply table. */
interface Reply {
  match: RegExp;
  stdout?: string;
  stderr?: string;
  code?: number;
  fail?: string;
  /** Leave the channel open, as a long-lived session does. */
  hold?: boolean;
}

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

const gz = Buffer.from("gzipped-binary");
const options = {
  version: "abc123",
  binaryForArch: async () => gz,
};

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

describe("remoteBinaryPath", () => {
  it("versions the path so a new build never reuses an old binary", () => {
    expect(remoteBinaryPath("abc123", "x86_64")).toBe(
      "$HOME/.cache/infrawrench/iwappd-abc123-x86_64",
    );
  });

  it("strips anything that would escape the path", () => {
    expect(remoteBinaryPath("../../etc/passwd; rm -rf /", "aarch64")).toBe(
      "$HOME/.cache/infrawrench/iwappd-....etcpasswdrm-rf-aarch64",
    );
  });

  it("refuses a version that sanitises away to nothing", () => {
    expect(() => remoteBinaryPath("$( )", "x86_64")).toThrow(AppServerError);
  });
});

describe("ensureAppServer", () => {
  it("uploads, verifies and reports the path when the host has nothing", async () => {
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "" },
      { match: /gunzip/, stdout: "" },
      { match: /--caps/, stdout: "{}" },
    ]);
    const stages: string[] = [];

    const result = await ensureAppServer(ssh, { ...options, onProgress: (s) => stages.push(s) });

    expect(result).toMatchObject({ arch: "x86_64", uploaded: true });
    expect(result.path).toContain("iwappd-abc123-x86_64");
    // The binary goes in over stdin of the gunzip command.
    const install = ssh.commands.find((c) => c.includes("gunzip"))!;
    expect(ssh.stdinByCommand.get(install)).toEqual(gz);
    expect(stages).toEqual(["detecting", "uploading", "verifying", "ready"]);
  });

  it("skips the upload when that exact build is already there", async () => {
    // The common case by a wide margin: a host is enrolled once and connected
    // to for months.
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "aarch64" },
      { match: /test -x/, stdout: "present" },
    ]);
    const binaryForArch = vi.fn(async () => gz);

    const result = await ensureAppServer(ssh, { ...options, binaryForArch });

    expect(result.uploaded).toBe(false);
    expect(binaryForArch).not.toHaveBeenCalled();
    expect(ssh.commands.some((c) => c.includes("gunzip"))).toBe(false);
  });

  it("writes a temporary and moves it, so a failed upload leaves nothing runnable", async () => {
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "" },
      { match: /gunzip/, stdout: "" },
      { match: /--caps/, stdout: "{}" },
    ]);
    await ensureAppServer(ssh, options);

    const install = ssh.commands.find((c) => c.includes("gunzip"))!;
    expect(install).toMatch(/set -e/);
    expect(install).toMatch(/\.part/);
    expect(install).toMatch(/mv -f .*\.part/);
    expect(install).toMatch(/chmod 700/);
  });

  it("surfaces the host's own error when the install fails", async () => {
    // A host without gunzip, or a read-only home: the message the user needs
    // is the shell's, not ours.
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "" },
      { match: /gunzip/, stderr: "sh: gunzip: not found", code: 127 },
    ]);
    await expect(ensureAppServer(ssh, options)).rejects.toThrow(/gunzip: not found/);
  });

  it("fails when the uploaded binary will not run", async () => {
    // The upload can succeed and the binary still be unusable — a noexec cache
    // directory, a truncated transfer. Running it is the only real check.
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "" },
      { match: /gunzip/, stdout: "" },
      { match: /--caps/, stderr: "Permission denied", code: 126 },
    ]);
    await expect(ensureAppServer(ssh, options)).rejects.toThrow(/would not start/);
  });
});

describe("startAppServer", () => {
  const ready = () =>
    new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "present" },
      { match: /--serve/, hold: true },
    ]);

  it("execs the server with the session's own socket namespace", async () => {
    const ssh = ready();
    await startAppServer(ssh, { ...options, sessionId: "sess-1", idleTimeoutSecs: 60 });
    const serve = ssh.commands.find((c) => c.includes("--serve"))!;
    expect(serve).toMatch(/--session-id 'sess-1'/);
    expect(serve).toMatch(/--idle-timeout 60/);
  });

  it("quotes a session id that would otherwise run a command", async () => {
    const ssh = ready();
    await startAppServer(ssh, { ...options, sessionId: "a'; rm -rf ~; echo '" });
    const serve = ssh.commands.find((c) => c.includes("--serve"))!;
    expect(serve).toContain(`'a'\\''; rm -rf ~; echo '\\'''`);
  });

  it("carries frames in both directions", async () => {
    const ssh = ready();
    const session = await startAppServer(ssh, { ...options, sessionId: "s" });
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
    const ssh = ready();
    const lines: string[] = [];
    await startAppServer(ssh, { ...options, sessionId: "s", onStderr: (l) => lines.push(l) });

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
    const ssh = ready();
    const session = await startAppServer(ssh, { ...options, sessionId: "s" });
    const codes: Array<number | null> = [];
    session.onClose((code) => codes.push(code));
    ssh.open[0]!.channel.emitClose(3);
    expect(codes).toEqual([3]);
  });
});

describe("listApps", () => {
  it("parses the host's application list", async () => {
    const apps = [{ id: "firefox.desktop", name: "Firefox" }];
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "present" },
      { match: /--list-apps/, stdout: JSON.stringify(apps) },
    ]);
    expect(await listApps(ssh, { ...options, iconSize: 32 })).toEqual(apps);
    expect(ssh.commands.at(-1)).toMatch(/--list-apps --json --icon-size 32/);
  });

  it("does not need a session, only the binary", async () => {
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "present" },
      { match: /--list-apps/, stdout: "[]" },
    ]);
    await listApps(ssh, options);
    expect(ssh.commands.some((c) => c.includes("--serve"))).toBe(false);
  });

  it("refuses output that is not an application list", async () => {
    const ssh = new FakeSsh([
      { match: /uname/, stdout: "x86_64" },
      { match: /test -x/, stdout: "present" },
      { match: /--list-apps/, stdout: "Welcome to Ubuntu!\n[]" },
    ]);
    // A login banner printed into stdout is the classic version of this.
    await expect(listApps(ssh, options)).rejects.toThrow(/not an application list/);
  });
});
