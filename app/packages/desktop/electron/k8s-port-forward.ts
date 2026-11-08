/**
 * `kubectl port-forward` as a stream (`K8sPortForwardOpen`): it emits
 * `Forwarding` with the bound local port once kubectl reports it, and ends
 * when kubectl exits. The stream's scope owns the process and its
 * kubeconfig, so interrupting it (stopping the forward, the renderer going
 * away) kills one and removes the other.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Effect, Queue, Stream } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import {
  K8sLocalError,
  type K8sPortForwardConfig,
  type K8sPortForwardEvent,
} from "../shared/rpc/groups/k8s-local";
import { acquireKubeconfigFile } from "./k8s-pty";
import { resolveBinaryPath } from "./pty";

/** How long kubectl gets to print its "Forwarding from" line. */
const START_TIMEOUT_MS = 15_000;

/** "Forwarding from 127.0.0.1:12345 -> 80" */
const FORWARDING_LINE = /Forwarding from (?:127\.0\.0\.1|\[::1]):(\d+)/;

/**
 * The port kubectl bound. Its stdout listener stays attached for the life of
 * the process: kubectl writes a line per connection, and an unread pipe
 * would eventually block it.
 */
const awaitForwarding = (proc: ChildProcess) =>
  Effect.callback<number, K8sLocalError>((resume) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    const settle = (effect: Effect.Effect<number, K8sLocalError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resume(effect);
    };
    const timeout = setTimeout(() => {
      settle(
        Effect.fail(
          new K8sLocalError({ message: "Timed out waiting for kubectl port-forward to start" }),
        ),
      );
    }, START_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBuf += chunk.toString("utf8");
      const match = FORWARDING_LINE.exec(stdoutBuf);
      if (match) settle(Effect.succeed(Number(match[1])));
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    proc.on("error", (err) => settle(Effect.fail(new K8sLocalError({ message: err.message }))));
    proc.on("exit", (code) => {
      if (code === 0) return;
      settle(
        Effect.fail(
          new K8sLocalError({
            message: `kubectl port-forward exited with code ${code}: ${stderrBuf.trim() || "(no output)"}`,
          }),
        ),
      );
    });
    return Effect.sync(() => clearTimeout(timeout));
  });

export const openPortForward = (
  config: K8sPortForwardConfig,
): Stream.Stream<K8sPortForwardEvent, K8sLocalError> =>
  Stream.callback<K8sPortForwardEvent, K8sLocalError>((output) =>
    Effect.gen(function* () {
      const { kubeconfigPath } = yield* acquireKubeconfigFile("iw-k8s-pf-", config.kubeconfig);
      let exited = false;
      let forwarding = false;
      const proc = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(
              resolveBinaryPath("kubectl"),
              [
                "port-forward",
                `${config.resourceType}/${config.resourceName}`,
                // 0 lets kubectl pick a free port.
                `${config.localPort ?? 0}:${config.remotePort}`,
                "-n",
                config.namespace,
                "--kubeconfig",
                kubeconfigPath,
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            ),
          catch: (cause) =>
            new K8sLocalError({
              message: `Failed to launch kubectl port-forward: ${errorMessage(cause)}`,
            }),
        }),
        (proc) =>
          Effect.sync(() => {
            if (!exited) proc.kill();
          }),
      );
      proc.on("exit", () => {
        exited = true;
        // Before `Forwarding`, an exit is `awaitForwarding`'s to report.
        if (forwarding) Queue.endUnsafe(output);
      });
      const localPort = yield* awaitForwarding(proc);
      forwarding = true;
      if (exited) {
        Queue.endUnsafe(output);
        return;
      }
      Queue.offerUnsafe(output, { _tag: "Forwarding", localPort });
    }),
  );
