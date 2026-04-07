import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "../lib/invoke";

const K9S_INSTALL_URL = "https://k9scli.io/topics/install/";

interface K9sTerminalProps {
  kubeconfig: string;
  namespace?: string;
}

export function K9sTerminal({ kubeconfig, namespace }: K9sTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [k9sInstalled, setK9sInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("k9s_check")
      .then((installed) => {
        if (!cancelled) setK9sInstalled(installed);
      })
      .catch(() => {
        if (!cancelled) setK9sInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (k9sInstalled !== true || !containerRef.current) return;

    const term = new Terminal({
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

    let sessionId: string | null = null;
    let disposed = false;

    requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();

      term.write("\x1b[90mLaunching k9s…\x1b[0m\r\n");

      invoke<string>("k9s_spawn", {
        kubeconfig,
        ...(namespace ? { namespace } : {}),
        cols: term.cols,
        rows: term.rows,
      })
        .then((id) => {
          if (disposed) {
            void invoke("k9s_kill", { sessionId: id });
            return;
          }
          sessionId = id;

          window.electronAPI.on(`k9s_data_${id}`, (...args) => {
            term.write(args[0] as Uint8Array);
          });

          window.electronAPI.on(`k9s_exit_${id}`, () => {
            term.write("\r\n\x1b[90m[Session closed]\x1b[0m\r\n");
          });
        })
        .catch((err: unknown) => {
          term.write(`\r\n\x1b[31mFailed: ${String(err)}\x1b[0m\r\n`);
        });
    });

    const onData = term.onData((data) => {
      if (sessionId) void invoke("k9s_write", { sessionId, data });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      if (sessionId) void invoke("k9s_resize", { sessionId, cols: term.cols, rows: term.rows });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      onData.dispose();
      if (sessionId) {
        window.electronAPI.offAll(`k9s_data_${sessionId}`);
        window.electronAPI.offAll(`k9s_exit_${sessionId}`);
        void invoke("k9s_kill", { sessionId });
      }
      term.dispose();
    };
  }, [k9sInstalled, kubeconfig, namespace]);

  if (k9sInstalled === null) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#0d0d0d] text-sm text-gray-500">
        Checking for k9s…
      </div>
    );
  }

  if (!k9sInstalled) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#0d0d0d] p-6">
        <div className="max-w-sm text-center space-y-3">
          <p className="text-base font-medium text-gray-200">k9s not found</p>
          <p className="text-sm text-gray-500">
            Install `k9s` locally to use the embedded Kubernetes terminal view.
          </p>
          <button
            onClick={() => void invoke("open_external_url", { url: K9S_INSTALL_URL })}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
          >
            Open install guide
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative bg-[#0d0d0d] overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  );
}
