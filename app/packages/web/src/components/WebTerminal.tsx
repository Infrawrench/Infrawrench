import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

interface WebTerminalProps {
  accountId: string;
  resourceId?: string;
  token: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}

export function WebTerminal({ accountId, resourceId, token, sshKeyId, sshHost, sshUsername }: WebTerminalProps) {
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

      term = new Terminal({
        theme: {
          background: "#0d0d0d",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          cursorAccent: "#0d0d0d",
          selectionBackground: "#264f78",
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

      // Guard terminal input — only forward after SSH session is ready.
      // Mirrors desktop's `if (shellId)` guard: xterm.js auto-sends device
      // attribute responses which must not reach the shell before it's ready.
      const onData = term.onData((data) => {
        if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "ssh:data", data: btoa(data) }));
        }
      });

      requestAnimationFrame(() => {
        if (disposed || !term) return;
        fitAddon.fit();

        const connectLabel = sshHost && sshUsername
          ? `${sshUsername}@${sshHost}:22`
          : "SSH";
        term.write(`\x1b[90mConnecting to \x1b[0m${connectLabel}\x1b[90m…\x1b[0m\r\n`);

        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`);
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "ssh:open", accountId, resourceId, sshKeyId, sshHost, sshUsername,
            cols: term!.cols, rows: term!.rows,
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            data?: string;
            error?: string;
          };

          switch (msg.type) {
            case "ssh:connected":
              connected = true;
              break;
            case "ssh:data":
              if (msg.data && term) {
                term.write(Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)));
              }
              break;
            case "ssh:error":
              term?.write(`\r\n\x1b[31m${msg.error ?? "Connection error"}\x1b[0m\r\n`);
              break;
            case "ssh:closed":
              connected = false;
              term?.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n");
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
          wsRef.current.send(JSON.stringify({ type: "ssh:resize", cols: term.cols, rows: term.rows }));
        }
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
  }, [accountId, resourceId, token, sshKeyId, sshHost, sshUsername]);

  return (
    <div className="h-full w-full relative bg-[#0d0d0d] overflow-hidden">
      <div
        ref={containerRef}
        className="absolute inset-0 p-2"
      />
    </div>
  );
}
