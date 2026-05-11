import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { getXtermTerminalOptions } from "@infrawrench/ui";

interface K8sExecTerminalProps {
  accountId: string;
  resourceId: string;
  peerPluginId: string;
  namespace: string;
  podName: string;
  containerName?: string | undefined;
  token: string;
}

export function K8sExecTerminal({
  accountId,
  resourceId,
  peerPluginId,
  namespace,
  podName,
  containerName,
  token,
}: K8sExecTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let term: import("@xterm/xterm").Terminal | null = null;
    let disposed = false;
    let connected = false;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (!containerRef.current || disposed) return;

      term = new Terminal(getXtermTerminalOptions());

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);

      const onData = term.onData((data) => {
        if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "k8s:exec:data", data: btoa(data) }));
        }
      });

      requestAnimationFrame(() => {
        if (disposed || !term) return;
        fitAddon.fit();

        term.write(
          `\x1b[90mConnecting to \x1b[0m${podName}\x1b[90m in \x1b[0m${namespace}\x1b[90m…\x1b[0m\r\n`,
        );

        const RETRYABLE_PATTERNS = [
          "no agent available",
          "error dialing backend",
          "container not found",
          "containerCreating",
          "waiting to start",
          "pod not running",
        ];
        const MAX_RETRIES = 15;
        const RETRY_DELAY_MS = 2_000;
        let retriesLeft = MAX_RETRIES;

        function isRetryableOutput(output: string): boolean {
          const lower = output.toLowerCase();
          return RETRYABLE_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
        }

        function openExecSession(ws: WebSocket) {
          connected = false;
          let outputBuffer = "";
          let connectTime = 0;

          ws.send(
            JSON.stringify({
              type: "k8s:exec:open",
              accountId,
              resourceId,
              peerPluginId,
              namespace,
              podName,
              containerName,
              cols: term!.cols,
              rows: term!.rows,
            }),
          );

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string) as {
              type: string;
              data?: string;
              error?: string;
              sessionId?: string;
              code?: number;
            };

            switch (msg.type) {
              case "k8s:exec:connected":
                connected = true;
                connectTime = Date.now();
                break;
              case "k8s:exec:data":
                if (msg.data && term) {
                  const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
                  term.write(bytes);
                  outputBuffer += new TextDecoder().decode(bytes);
                }
                break;
              case "k8s:exec:error":
                term?.write(`\r\n\x1b[31m${msg.error ?? "Exec failed"}\x1b[0m\r\n`);
                break;
              case "k8s:exec:closed": {
                connected = false;
                const elapsed = connectTime > 0 ? Date.now() - connectTime : 0;
                if (
                  retriesLeft > 0 &&
                  elapsed < 8_000 &&
                  isRetryableOutput(outputBuffer) &&
                  !disposed &&
                  ws.readyState === WebSocket.OPEN
                ) {
                  retriesLeft--;
                  term?.write(
                    `\x1b[90mWaiting for pod to be ready… (retrying in ${RETRY_DELAY_MS / 1000}s)\x1b[0m\r\n`,
                  );
                  setTimeout(() => {
                    if (!disposed && ws.readyState === WebSocket.OPEN) openExecSession(ws);
                  }, RETRY_DELAY_MS);
                } else {
                  term?.write("\r\n\x1b[90m[Session closed]\x1b[0m\r\n");
                }
                break;
              }
            }
          };
        }

        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => openExecSession(ws);

        ws.onerror = () => {
          term?.write("\r\n\x1b[31mWebSocket connection failed\x1b[0m\r\n");
        };
      });

      const ro = new ResizeObserver(() => {
        if (disposed || !term) return;
        fitAddon.fit();
      });
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        onData.dispose();
      };
    }

    const cleanup = init();

    return () => {
      disposed = true;
      cleanup?.then((fn) => fn?.());
      wsRef.current?.close();
      term?.dispose();
    };
  }, [accountId, resourceId, peerPluginId, namespace, podName, containerName, token]);

  return (
    <div className="h-full w-full relative bg-[var(--color-terminal-bg)] overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  );
}
