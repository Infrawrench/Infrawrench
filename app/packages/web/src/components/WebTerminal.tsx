"use client";

import { useEffect, useRef, useState } from "react";

interface WebTerminalProps {
  accountId: string;
  resourceId?: string;
  token: string;
}

export function WebTerminal({ accountId, resourceId, token }: WebTerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let terminal: import("@xterm/xterm").Terminal | null = null;
    let fitAddon: import("@xterm/addon-fit").FitAddon | null = null;

    async function init() {
      // Dynamic import xterm (browser-only)
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      // CSS imported in globals.css or via link tag
      if (!termRef.current) return;

      terminal = new Terminal({
        theme: {
          background: "#0a0a0a",
          foreground: "#e5e5e5",
          cursor: "#e5e5e5",
        },
        fontSize: 13,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        cursorBlink: true,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(termRef.current);
      fitAddon.fit();

      // Connect WebSocket
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "ssh:open", accountId, resourceId }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          data?: string;
          error?: string;
        };

        switch (msg.type) {
          case "ssh:connected":
            setStatus("connected");
            if (fitAddon) {
              const dims = fitAddon.proposeDimensions();
              if (dims) {
                ws.send(JSON.stringify({ type: "ssh:resize", cols: dims.cols, rows: dims.rows }));
              }
            }
            break;
          case "ssh:data":
            if (msg.data && terminal) {
              terminal.write(Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)));
            }
            break;
          case "ssh:error":
            setStatus("error");
            setError(msg.error ?? "Connection error");
            break;
          case "ssh:closed":
            setStatus("disconnected");
            break;
        }
      };

      ws.onclose = () => {
        setStatus("disconnected");
      };

      ws.onerror = () => {
        setStatus("error");
        setError("WebSocket connection failed");
      };

      // Terminal input → WebSocket
      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ssh:data", data: btoa(data) }));
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        if (fitAddon) {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ssh:resize", cols: dims.cols, rows: dims.rows }));
          }
        }
      });
      resizeObserver.observe(termRef.current);

      return () => {
        resizeObserver.disconnect();
      };
    }

    init();

    return () => {
      wsRef.current?.close();
      terminal?.dispose();
    };
  }, [accountId, resourceId, token]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800">
        <span
          className={`w-2 h-2 rounded-full ${
            status === "connected"
              ? "bg-green-400"
              : status === "connecting"
                ? "bg-yellow-400 animate-pulse"
                : "bg-red-400"
          }`}
        />
        <span className="text-xs text-gray-400">
          {status === "connected"
            ? "Connected"
            : status === "connecting"
              ? "Connecting..."
              : status === "error"
                ? error ?? "Error"
                : "Disconnected"}
        </span>
      </div>
      <div ref={termRef} className="flex-1 bg-[#0a0a0a]" />
    </div>
  );
}
