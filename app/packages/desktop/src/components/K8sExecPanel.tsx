import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme } from "@infrawrench/ui";
import { openK8sExec, type K8sSessionHandle } from "../lib/k8s-dispatch";

interface K8sExecCloudContext {
  orgId: string;
  accountId: string;
  resourceId: string;
  peerPluginId: string;
}

interface K8sExecPanelProps {
  /** Required for local mode (no cloudContext). */
  kubeconfig?: string;
  cloudContext?: K8sExecCloudContext;
  namespace: string;
  podName: string;
  containerName?: string;
}

export function K8sExecPanel({
  kubeconfig,
  cloudContext,
  namespace,
  podName,
  containerName,
}: K8sExecPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const termTheme = getTerminalTheme();
    const term = new Terminal({
      theme: {
        ...termTheme,
        black: "#1e1e1e",
        red: "#f44747",
        green: "#4ec9b0",
        yellow: "#dcdcaa",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#9cdcfe",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#4ec9b0",
        brightYellow: "#dcdcaa",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#9cdcfe",
        brightWhite: "#ffffff",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      allowTransparency: true,
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    let session: K8sSessionHandle | null = null;
    let disposed = false;

    requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();
      term.write(`\x1b[90mConnecting to ${podName} in ${namespace}…\x1b[0m\r\n`);

      const MAX_RETRIES = 15;
      const RETRY_DELAY_MS = 2_000;
      // Transient errors from kubectl that are safe to retry.
      const RETRYABLE_PATTERNS = [
        "no agent available",
        "error dialing backend",
        "container not found",
        "containerCreating",
        "waiting to start",
        "pod not running",
      ];

      function isRetryableOutput(output: string): boolean {
        const lower = output.toLowerCase();
        return RETRYABLE_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
      }

      function attemptConnect(retriesLeft: number) {
        if (disposed) return;
        const openPromise = cloudContext
          ? openK8sExec({
              mode: "cloud",
              orgId: cloudContext.orgId,
              accountId: cloudContext.accountId,
              resourceId: cloudContext.resourceId,
              peerPluginId: cloudContext.peerPluginId,
              namespace,
              podName,
              ...(containerName ? { containerName } : {}),
              cols: term.cols,
              rows: term.rows,
            })
          : openK8sExec({
              mode: "local",
              kubeconfig: kubeconfig ?? "",
              namespace,
              podName,
              ...(containerName ? { containerName } : {}),
              cols: term.cols,
              rows: term.rows,
            });

        openPromise
          .then((handle) => {
            if (disposed) {
              handle.kill();
              return;
            }
            session = handle;

            let outputBuffer = "";
            const connectTime = Date.now();

            handle.onData((data) => {
              term.write(data);
              outputBuffer += new TextDecoder().decode(data);
            });

            handle.onExit(() => {
              session = null;
              const elapsed = Date.now() - connectTime;
              // Retry if kubectl exited very quickly with a known transient error.
              if (
                retriesLeft > 0 &&
                elapsed < 8_000 &&
                isRetryableOutput(outputBuffer) &&
                !disposed
              ) {
                term.write(
                  `\x1b[90mWaiting for pod to be ready… (retrying in ${RETRY_DELAY_MS / 1000}s)\x1b[0m\r\n`,
                );
                setTimeout(() => attemptConnect(retriesLeft - 1), RETRY_DELAY_MS);
              } else {
                term.write("\r\n\x1b[90m[Session closed]\x1b[0m\r\n");
              }
            });

            handle.onError((err) => term.write(`\r\n\x1b[31m${err}\x1b[0m\r\n`));
          })
          .catch((err: unknown) => {
            if (retriesLeft > 0 && !disposed) {
              term.write(
                `\x1b[90mWaiting for pod to be ready… (retrying in ${RETRY_DELAY_MS / 1000}s)\x1b[0m\r\n`,
              );
              setTimeout(() => attemptConnect(retriesLeft - 1), RETRY_DELAY_MS);
            } else {
              term.write(`\r\n\x1b[31mFailed: ${String(err)}\x1b[0m\r\n`);
            }
          });
      }

      attemptConnect(MAX_RETRIES);
    });

    const onData = term.onData((data) => session?.write(data));

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      session?.resize(term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      onData.dispose();
      session?.kill();
      term.dispose();
    };
  }, [
    containerName,
    kubeconfig,
    namespace,
    podName,
    cloudContext?.orgId,
    cloudContext?.accountId,
    cloudContext?.resourceId,
    cloudContext?.peerPluginId,
  ]);

  return (
    <div className="h-full w-full relative bg-[var(--color-terminal-bg)] overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  );
}
