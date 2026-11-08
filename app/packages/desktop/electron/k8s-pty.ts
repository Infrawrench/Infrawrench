/**
 * What `kubectl exec`, k9s and `kubectl port-forward` share: a kubeconfig
 * written to a private temp dir for the life of the process, and (for the
 * two terminals) a PTY whose session is a stream.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Queue, Stream } from "effect";
import { spawn, type IPty } from "node-pty";
import { errorMessage } from "../shared/rpc/errors";
import { K8sLocalError, type K8sTerminalEvent } from "../shared/rpc/groups/k8s-local";
import { buildPtyEnv, ensureNodePtySpawnHelperExecutable, resolveBinaryPath } from "./pty";

/**
 * The kubeconfig as a file only its process reads (mode 0600, a fresh
 * `mkdtemp` dir), removed with the dir when the scope closes.
 */
export const acquireKubeconfigFile = (tmpPrefix: string, kubeconfig: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
        const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
        fs.writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });
        return { tmpDir, kubeconfigPath };
      },
      catch: (cause) => new K8sLocalError({ message: errorMessage(cause) }),
    }),
    ({ tmpDir }) => Effect.sync(() => removeTmpDir(tmpDir)),
  );

/** Remove a kubeconfig's temp dir; safe to call more than once. */
export function removeTmpDir(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore temp cleanup failures.
  }
}

interface KubePtyConfig {
  readonly kubeconfig: string;
  readonly cols: number;
  readonly rows: number;
}

interface KubePtyLaunch<C extends KubePtyConfig> {
  /** Looked up on the user's PATH (`which`). */
  readonly binary: string;
  readonly tmpPrefix: string;
  /** For the launch failure: `Failed to launch <label>: ...`. */
  readonly label: string;
  readonly args: (config: C, kubeconfigPath: string) => string[];
}

interface PtySession {
  readonly proc: IPty;
  readonly tmpDir: string;
  /** The RPC client (renderer connection) that opened it; only it may write. */
  readonly owner: number;
}

/**
 * Terminals of one kind. `open` is the session: subscribing writes the
 * kubeconfig and spawns the PTY, `Opened` comes first and the output after
 * it, and the stream ends when the process exits. Its scope owns the process
 * and the kubeconfig, so interrupting the stream kills one and removes the
 * other.
 */
export function makeKubePtySessions<C extends KubePtyConfig>(launch: KubePtyLaunch<C>) {
  const sessions = new Map<string, PtySession>();

  const open = (config: C, owner: number): Stream.Stream<K8sTerminalEvent, K8sLocalError> =>
    Stream.callback<K8sTerminalEvent, K8sLocalError>((output) =>
      Effect.gen(function* () {
        const { tmpDir, kubeconfigPath } = yield* acquireKubeconfigFile(
          launch.tmpPrefix,
          config.kubeconfig,
        );
        const sessionId = randomUUID();
        let exited = false;
        const proc = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              ensureNodePtySpawnHelperExecutable();
              return spawn(resolveBinaryPath(launch.binary), launch.args(config, kubeconfigPath), {
                name: "xterm-256color",
                cols: config.cols,
                rows: config.rows,
                env: buildPtyEnv(config.cols, config.rows),
              });
            },
            catch: (cause) =>
              new K8sLocalError({
                message: `Failed to launch ${launch.label}: ${errorMessage(cause)}`,
              }),
          }),
          (proc) =>
            Effect.sync(() => {
              sessions.delete(sessionId);
              if (!exited) proc.kill();
            }),
        );
        sessions.set(sessionId, { proc, tmpDir, owner });
        Queue.offerUnsafe(output, { _tag: "Opened", sessionId });
        proc.onData((data) => {
          Queue.offerUnsafe(output, { _tag: "Data", data: Buffer.from(data, "utf8") });
        });
        proc.onExit(() => {
          exited = true;
          sessions.delete(sessionId);
          Queue.endUnsafe(output);
        });
      }),
    );

  const write = (sessionId: string, owner: number, data: string) =>
    Effect.sync(() => {
      const session = sessions.get(sessionId);
      if (session?.owner === owner) session.proc.write(data);
    });

  const resize = (sessionId: string, owner: number, cols: number, rows: number) =>
    Effect.sync(() => {
      const session = sessions.get(sessionId);
      if (session?.owner === owner) session.proc.resize(cols, rows);
    });

  /**
   * On quit: kill every process and remove its kubeconfig now, since the app
   * may be gone before the exit ends the stream and closes its scope.
   */
  const killAll = (): void => {
    for (const session of sessions.values()) {
      try {
        session.proc.kill();
      } catch {
        // Already gone.
      }
      removeTmpDir(session.tmpDir);
    }
  };

  return { open, write, resize, killAll };
}
