import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  attachAltBufferScrollHandler,
  attachTerminalClipboard,
  getXtermTerminalOptions,
} from "@infrawrench/ui";

interface K9sTerminalProps {
  accountId: string;
  resourceId: string;
  peerPluginId: string;
  namespace?: string | undefined;
  token: string;
}

export function K9sTerminal({
  accountId,
  resourceId,
  peerPluginId,
  namespace,
  token,
}: K9sTerminalProps) {
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

      const clipboard = attachTerminalClipboard(term);

      const sendToSession = (data: string) => {
        if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "k9s:data", data: btoa(data) }));
        }
      };
      const onData = term.onData(sendToSession);
      const altScroll = attachAltBufferScrollHandler(term, sendToSession);

      requestAnimationFrame(() => {
        if (disposed || !term) return;
        fitAddon.fit();
        term.write("\x1b[90mLaunching k9s…\x1b[0m\r\n");

        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "k9s:open",
              accountId,
              resourceId,
              peerPluginId,
              ...(namespace ? { namespace } : {}),
              cols: term!.cols,
              rows: term!.rows,
            }),
          );
          connected = true;
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            data?: string;
            error?: string;
          };
          switch (msg.type) {
            case "k9s:data":
              if (msg.data && term) {
                term.write(Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)));
              }
              break;
            case "k9s:error":
              term?.write(`\r\n\x1b[31m${msg.error ?? "k9s failed"}\x1b[0m\r\n`);
              break;
            case "k9s:closed":
              connected = false;
              term?.write("\r\n\x1b[90m[Session closed]\x1b[0m\r\n");
              break;
          }
        };

        ws.onerror = () => {
          term?.write("\r\n\x1b[31mWebSocket connection failed\x1b[0m\r\n");
        };
      });

      const ro = new ResizeObserver(() => {
        if (disposed || !term) return;
        fitAddon.fit();
        if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({ type: "k9s:resize", cols: term.cols, rows: term.rows }),
          );
        }
      });
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        onData.dispose();
        altScroll.dispose();
        clipboard.dispose();
      };
    }

    const cleanup = init();

    return () => {
      disposed = true;
      cleanup?.then((fn) => fn?.());
      wsRef.current?.close();
      term?.dispose();
    };
  }, [accountId, resourceId, peerPluginId, namespace, token]);

  return (
    <div className="h-full w-full relative bg-[var(--color-terminal-bg)] overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  );
}
