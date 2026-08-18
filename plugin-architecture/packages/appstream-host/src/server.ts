/**
 * Getting `iwappd` onto a customer's host, running it, and leaving nothing
 * behind.
 *
 * Both apps end up here by different routes — the desktop app has an ssh2
 * client from `electron/ssh-shell.ts`, the web server from
 * `services/ssh-proxy.ts` — but what happens over that connection is identical,
 * so it lives once. The binaries themselves come from each app's own
 * `getx86_64GzBinary()` / `getArm64GzBinary()`, which is the only part that
 * legitimately differs.
 *
 * **The binary is never installed.** It is written to a RAM-backed directory,
 * opened, unlinked, and executed through the open descriptor, so from the
 * moment it starts there is no file on the customer's machine — nothing to
 * find, nothing to clean up, nothing left after the session ends or the
 * connection drops. That costs about a megabyte of upload per session, which is
 * the right trade: we are running a binary on someone else's computer, and the
 * polite version of that does not leave it there.
 *
 * Nothing here opens a connection or verifies a host key. That is the caller's
 * job precisely because each app already does it, with its own TOFU store and
 * its own jumpbox chain.
 */

import {
  AppServerError,
  execCommand,
  pickStagingDirScript,
  shellQuote,
  type ExecResult,
  type SshExecutor,
} from "./exec.js";

export type RemoteArch = "x86_64" | "aarch64";

export interface BinarySource {
  /** The app's own gz binary source, per architecture. */
  binaryForArch: (arch: RemoteArch) => Promise<Buffer>;
  /** Called with progress, for a UI that wants to say "uploading…". */
  onProgress?: (stage: "detecting" | "uploading" | "starting" | "ready") => void;
}

/** What `uname -m` says, normalised to the two targets we build. */
export async function detectArch(conn: SshExecutor): Promise<RemoteArch> {
  const { stdout, stderr, code } = await execCommand(conn, "uname -m");
  if (code !== 0) {
    throw new AppServerError(
      "could not read the host's architecture",
      stderr.trim() || `exit ${code}`,
    );
  }
  const machine = stdout.trim().toLowerCase();
  if (machine === "x86_64" || machine === "amd64") return "x86_64";
  if (machine === "aarch64" || machine === "arm64") return "aarch64";
  throw new AppServerError(
    `no app server build for this host's architecture (${machine || "unknown"})`,
  );
}

/**
 * Stage the binary in RAM and hand back the path it landed at.
 *
 * The file is deliberately short-lived: whoever gets this path is expected to
 * open, unlink and exec it immediately. A watchdog removes it a minute later
 * regardless, so a client that dies between staging and starting cannot leave
 * anything behind.
 */
async function stageBinary(conn: SshExecutor, source: BinarySource): Promise<string> {
  source.onProgress?.("detecting");
  const arch = await detectArch(conn);

  source.onProgress?.("uploading");
  const gz = await source.binaryForArch(arch);

  const script = [
    "set -e",
    `dir=$(${pickStagingDirScript()})`,
    '[ -n "$dir" ] || { echo "no writable, exec-capable directory for staging" >&2; exit 1; }',
    'f=$(mktemp "$dir/.iw.XXXXXXXX")',
    'gunzip -c > "$f"',
    'chmod 700 "$f"',
    // If nobody execs it, it disappears anyway: a client that dies between
    // staging and starting must not leave a binary on someone's machine.
    '(sleep 60; rm -f "$f") >/dev/null 2>&1 &',
    'echo "$f"',
  ].join("\n");

  const staged = await execCommand(conn, `sh -c ${shellQuote(script)}`, gz);
  const path = staged.stdout.trim().split("\n").pop() ?? "";
  if (staged.code !== 0 || !path.startsWith("/")) {
    throw new AppServerError(
      "could not stage the app server on the host",
      staged.stderr.trim() || `exit ${staged.code}`,
    );
  }
  return path;
}

/**
 * Run a staged binary and delete it in the same breath.
 *
 * `exec 3< "$f"` keeps the inode alive through the `rm`, and Linux will execute
 * an unlinked file through `/proc/self/fd`. The shell then `exec`s so no extra
 * process sits between the SSH channel and the app server — the channel's
 * stdin, stdout and signals belong to it directly.
 */
function runAndUnlinkScript(path: string, args: string): string {
  return [
    "set -e",
    `f=${shellQuote(path)}`,
    'exec 3< "$f"',
    'rm -f "$f"',
    `exec /proc/self/fd/3 ${args}`,
  ].join("\n");
}

export interface SessionOptions extends BinarySource {
  /** Namespaces the Wayland socket, so two sessions on one host do not collide. */
  sessionId: string;
  /** Exit after this long with no client and no windows. Zero disables it. */
  idleTimeoutSecs?: number;
  /** Icon size the launcher asks the host to resolve. */
  iconSize?: number;
  /** Diagnostics from the host, which are the whole story when a launch fails. */
  onStderr?: (line: string) => void;
}

export interface AppServerSession {
  /** Frames from the host. */
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: (code: number | null) => void): void;
  /** Frames to the host. */
  write(chunk: Buffer): void;
  close(): void;
  arch: RemoteArch;
}

/**
 * Upload, run, and unlink: the app server is streaming frames before its file
 * has existed for a second, and nothing remains on the host afterwards.
 *
 * The protocol lives on stdin and stdout, which is why staging and running are
 * two channels rather than one — the upload has to finish and close its stdin
 * before the server's stdin can start carrying frames.
 */
export async function startAppServer(
  conn: SshExecutor,
  options: SessionOptions,
): Promise<AppServerSession> {
  const staged = await stageBinary(conn, options);
  const arch = await detectArch(conn);

  const args = [
    "--serve",
    `--session-id ${shellQuote(options.sessionId)}`,
    ...(options.idleTimeoutSecs !== undefined
      ? [`--idle-timeout ${Math.max(0, Math.floor(options.idleTimeoutSecs))}`]
      : []),
    ...(options.iconSize !== undefined ? [`--icon-size ${Math.floor(options.iconSize)}`] : []),
  ].join(" ");

  options.onProgress?.("starting");
  return new Promise((resolve, reject) => {
    conn.exec(`sh -c ${shellQuote(runAndUnlinkScript(staged, args))}`, (err, channel) => {
      if (err) {
        reject(new AppServerError("could not start the app server", err.message));
        return;
      }

      let stderr = "";
      channel.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        const lines = stderr.split("\n");
        stderr = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) options.onStderr?.(line);
      });

      // A session ends two ways: the command exits, or the connection under it
      // fails. Both have to reach the caller as the same thing, and the second
      // one arrives as an `error` event on a stream — which, unhandled, ends
      // the *process* rather than the session. On a server holding other
      // people's sessions that is everyone's problem, not this caller's.
      let closed: ((code: number | null) => void) | undefined;
      let finished = false;
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        closed?.(code);
      };
      channel.on("close", (code) => finish(code ?? null));
      channel.once("error", (err) => {
        options.onStderr?.(`connection lost: ${err.message}`);
        finish(null);
      });
      channel.stderr.once("error", () => {
        /* the diagnostics stream going away is not worth ending a session for */
      });

      options.onProgress?.("ready");
      resolve({
        arch,
        onData: (handler) => channel.on("data", handler),
        onClose: (handler) => {
          closed = handler;
        },
        // Writing to a channel whose connection has gone throws from inside
        // whatever was relaying — a WebSocket's message handler, typically,
        // where an exception is again the process rather than the session.
        write: (chunk) => {
          if (finished) return;
          try {
            channel.write(chunk);
          } catch {
            finish(null);
          }
        },
        close: () => {
          try {
            channel.end();
          } catch {
            /* already gone */
          }
        },
      });
    });
  });
}

/**
 * The installed applications, without starting a session.
 *
 * One channel rather than two: this command needs no stdin of its own, so the
 * upload, the run and the delete all fit in a single exec.
 */
export async function listApps(
  conn: SshExecutor,
  options: BinarySource & { iconSize?: number },
): Promise<unknown[]> {
  options.onProgress?.("detecting");
  const arch = await detectArch(conn);
  options.onProgress?.("uploading");
  const gz = await options.binaryForArch(arch);

  const iconSize =
    options.iconSize !== undefined ? ` --icon-size ${Math.floor(options.iconSize)}` : "";
  const script = [
    "set -e",
    `dir=$(${pickStagingDirScript()})`,
    '[ -n "$dir" ] || { echo "no writable, exec-capable directory for staging" >&2; exit 1; }',
    'f=$(mktemp "$dir/.iw.XXXXXXXX")',
    'gunzip -c > "$f"',
    'chmod 700 "$f"',
    'exec 3< "$f"',
    'rm -f "$f"',
    `/proc/self/fd/3 --list-apps --json${iconSize}`,
  ].join("\n");

  const result = await execCommand(conn, `sh -c ${shellQuote(script)}`, gz);
  if (result.code !== 0) {
    throw new AppServerError(
      "could not list the applications on this host",
      result.stderr.trim() || `exit ${result.code}`,
    );
  }
  // A login banner on stdout is the classic way this arrives as garbage, so
  // parse the last line rather than the whole stream.
  const line = result.stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new AppServerError(
      "the app server returned something that is not an application list",
      line.slice(0, 200),
    );
  }
}
