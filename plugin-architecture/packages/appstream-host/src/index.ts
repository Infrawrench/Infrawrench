/**
 * Getting `iwappd` onto a customer's host and running it.
 *
 * Both apps end up here by different routes — the desktop app has an ssh2
 * client from `electron/ssh-shell.ts`, the web server from
 * `services/ssh-proxy.ts` — but what happens over that connection is identical,
 * so it lives once. The binaries themselves come from each app's own
 * `getx86_64GzBinary()` / `getArm64GzBinary()`, which is the only part that
 * legitimately differs.
 *
 * Nothing here opens a connection or verifies a host key. That is the caller's
 * job precisely because each app already does it, with its own TOFU store and
 * its own jumpbox chain.
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
  stderr: { on(event: "data", handler: (chunk: Buffer) => void): unknown };
  write(chunk: Buffer | string): unknown;
  end(): unknown;
}

export type RemoteArch = "x86_64" | "aarch64";

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "AppServerError";
  }
}

export interface EnsureOptions {
  /**
   * Identity of the binaries — the `linux-appserver/` hash the apps build
   * from. It is part of the cached path, so a new build lands under a new name
   * and an old one is never silently reused.
   */
  version: string;
  /** The app's own gz binary source, per architecture. */
  binaryForArch: (arch: RemoteArch) => Promise<Buffer>;
  /** Defaults to `~/.cache/infrawrench`. */
  cacheDir?: string;
  /** Called with progress, for a UI that wants to say "uploading…". */
  onProgress?: (stage: "detecting" | "uploading" | "verifying" | "ready") => void;
}

export interface EnsureResult {
  path: string;
  arch: RemoteArch;
  /** False when the host already had this exact build. */
  uploaded: boolean;
}

interface ExecResult {
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
 * Path the binary lives at on the host. Versioned, so a client carrying a
 * newer build never runs an older one left by a previous session.
 */
export function remoteBinaryPath(version: string, arch: RemoteArch, cacheDir?: string): string {
  const dir = cacheDir ?? "$HOME/.cache/infrawrench";
  return `${dir}/iwappd-${sanitiseVersion(version)}-${arch}`;
}

/**
 * Version strings become part of a shell path, so anything that is not
 * obviously safe is dropped rather than quoted around.
 */
function sanitiseVersion(version: string): string {
  const safe = version.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  if (!safe) throw new AppServerError("the binary version is empty after sanitising");
  return safe;
}

/**
 * Make sure the right `iwappd` is on the host, uploading it if it is not.
 *
 * The upload goes through `gunzip` on the far side rather than SFTP: it is one
 * exec on a connection we already have, it works on hosts with the SFTP
 * subsystem disabled, and it never leaves a half-written file at the final
 * path because the decompression writes a temporary and moves it into place.
 */
export async function ensureAppServer(
  conn: SshExecutor,
  options: EnsureOptions,
): Promise<EnsureResult> {
  options.onProgress?.("detecting");
  const arch = await detectArch(conn);
  const path = remoteBinaryPath(options.version, arch, options.cacheDir);

  const present = await execCommand(conn, `test -x ${path} && echo present || true`);
  if (present.stdout.trim() === "present") {
    options.onProgress?.("ready");
    return { path, arch, uploaded: false };
  }

  options.onProgress?.("uploading");
  const gz = await options.binaryForArch(arch);
  const dir = options.cacheDir ?? "$HOME/.cache/infrawrench";
  const temp = `${path}.$$.part`;
  // `set -e` so a missing gunzip fails here rather than leaving an empty file
  // that later fails as "not executable"; the move is last so the final path
  // only ever exists complete.
  const install = [
    "set -e",
    `mkdir -p ${dir}`,
    `gunzip -c > ${temp}`,
    `chmod 700 ${temp}`,
    `mv -f ${temp} ${path}`,
    // Older builds are dead weight on someone else's disk.
    `find ${dir} -maxdepth 1 -name 'iwappd-*' ! -name '${basename(path)}' -mmin +1 -delete 2>/dev/null || true`,
  ].join("; ");

  const installed = await execCommand(conn, `sh -c '${install}'`, gz);
  if (installed.code !== 0) {
    throw new AppServerError(
      "could not install the app server on the host",
      installed.stderr.trim() || `exit ${installed.code}`,
    );
  }

  options.onProgress?.("verifying");
  // Running it is the only check that means anything: the upload can succeed
  // and the binary still be wrong for this host — the wrong libc, a truncated
  // transfer, a noexec mount on the cache directory.
  const caps = await execCommand(conn, `${path} --caps --json`);
  if (caps.code !== 0) {
    throw new AppServerError(
      "the app server would not start on this host",
      caps.stderr.trim() || `exit ${caps.code}`,
    );
  }

  options.onProgress?.("ready");
  return { path, arch, uploaded: true };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface SessionOptions extends EnsureOptions {
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
  path: string;
}

/**
 * Ensure the binary, then exec it and hand back the raw channel.
 *
 * The protocol lives on stdin and stdout; stderr is diagnostics only, and is
 * surfaced line by line because "the app exited immediately" is nearly always
 * a missing library whose real message is on stderr.
 */
export async function startAppServer(
  conn: SshExecutor,
  options: SessionOptions,
): Promise<AppServerSession> {
  const { path, arch } = await ensureAppServer(conn, options);

  const args = [
    "--serve",
    `--session-id ${shellQuote(options.sessionId)}`,
    ...(options.idleTimeoutSecs !== undefined
      ? [`--idle-timeout ${Math.max(0, Math.floor(options.idleTimeoutSecs))}`]
      : []),
    ...(options.iconSize !== undefined ? [`--icon-size ${Math.floor(options.iconSize)}`] : []),
  ].join(" ");

  return new Promise((resolve, reject) => {
    conn.exec(`${path} ${args}`, (err, channel) => {
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

      resolve({
        arch,
        path,
        onData: (handler) => channel.on("data", handler),
        onClose: (handler) => channel.on("close", (code) => handler(code ?? null)),
        write: (chunk) => channel.write(chunk),
        close: () => channel.end(),
      });
    });
  });
}

/**
 * The installed applications, without starting a session.
 *
 * This is what `infrawrench apps list` and the launcher's first paint use: one
 * exec, no compositor, no Wayland socket. The JSON is the same `AppEntry[]` the
 * protocol carries.
 */
export async function listApps(
  conn: SshExecutor,
  options: EnsureOptions & { iconSize?: number },
): Promise<unknown[]> {
  const { path } = await ensureAppServer(conn, options);
  const iconSize =
    options.iconSize !== undefined ? ` --icon-size ${Math.floor(options.iconSize)}` : "";
  const result = await execCommand(conn, `${path} --list-apps --json${iconSize}`);
  if (result.code !== 0) {
    throw new AppServerError(
      "could not list the applications on this host",
      result.stderr.trim() || `exit ${result.code}`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new AppServerError(
      "the app server returned something that is not an application list",
      result.stdout.slice(0, 200),
    );
  }
}

/** Single-quote a value for `sh`, closing and reopening around any quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
