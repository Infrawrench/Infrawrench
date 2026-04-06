import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "../lib/invoke";

interface SshTerminalProps {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export function SshTerminal({ host, port, username, privateKey }: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

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

    let shellId: string | null = null;
    let disposed = false;

    // Defer fit until the browser has laid out the container — calling fit()
    // synchronously after open() can fail if the element has no dimensions yet.
    requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();

      term.write("\x1b[90mConnecting to \x1b[0m" + `${username}@${host}:${port}` + "\x1b[90m…\x1b[0m\r\n");

      invoke<string>("ssh_shell_spawn", {
        host,
        port,
        username,
        privateKey,
        cols: term.cols,
        rows: term.rows,
      }).then((id) => {
        if (disposed) {
          void invoke("ssh_shell_kill", { shellId: id });
          return;
        }
        shellId = id;

        window.electronAPI.on(`ssh_shell_data_${id}`, (...args) => {
          term.write(args[0] as string);
        });

        window.electronAPI.on(`ssh_shell_exit_${id}`, () => {
          term.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n");
        });
      }).catch((err: unknown) => {
        term.write(`\r\n\x1b[31mFailed: ${String(err)}\x1b[0m\r\n`);
      });
    }); // end requestAnimationFrame

    const onData = term.onData((data) => {
      if (shellId) void invoke("ssh_shell_write", { shellId, data });
    });

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      if (shellId) {
        void invoke("ssh_shell_resize", { shellId, cols: term.cols, rows: term.rows });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      onData.dispose();
      if (shellId) {
        window.electronAPI.offAll(`ssh_shell_data_${shellId}`);
        window.electronAPI.offAll(`ssh_shell_exit_${shellId}`);
        void invoke("ssh_shell_kill", { shellId });
      }
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, username, privateKey]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#0d0d0d] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-950 shrink-0">
        <span className="text-xs text-gray-500 font-mono">{username}@{host}:{port}</span>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-2"
        style={{ contain: "strict" }}
      />
    </div>
  );
}
