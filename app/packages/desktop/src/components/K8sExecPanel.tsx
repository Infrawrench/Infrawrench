import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "../lib/invoke";

interface K8sExecPanelProps {
  kubeconfig: string;
  namespace: string;
  podName: string;
  containerName?: string;
}

export function K8sExecPanel({
  kubeconfig,
  namespace,
  podName,
  containerName,
}: K8sExecPanelProps) {
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

    let sessionId: string | null = null;
    let disposed = false;

    requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();

      term.write(
        `\x1b[90mConnecting to ${podName} in ${namespace}…\x1b[0m\r\n`,
      );

      invoke<string>("k8s_exec_spawn", {
        kubeconfig,
        namespace,
        podName,
        ...(containerName ? { containerName } : {}),
        cols: term.cols,
        rows: term.rows,
      })
        .then((id) => {
          if (disposed) {
            void invoke("k8s_exec_kill", { sessionId: id });
            return;
          }
          sessionId = id;

          window.electronAPI.on(`k8s_exec_data_${id}`, (...args) => {
            term.write(args[0] as Uint8Array);
          });

          window.electronAPI.on(`k8s_exec_exit_${id}`, () => {
            term.write("\r\n\x1b[90m[Session closed]\x1b[0m\r\n");
          });
        })
        .catch((err: unknown) => {
          term.write(`\r\n\x1b[31mFailed: ${String(err)}\x1b[0m\r\n`);
        });
    });

    const onData = term.onData((data) => {
      if (sessionId) void invoke("k8s_exec_write", { sessionId, data });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      if (sessionId) {
        void invoke("k8s_exec_resize", { sessionId, cols: term.cols, rows: term.rows });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      onData.dispose();
      if (sessionId) {
        window.electronAPI.offAll(`k8s_exec_data_${sessionId}`);
        window.electronAPI.offAll(`k8s_exec_exit_${sessionId}`);
        void invoke("k8s_exec_kill", { sessionId });
      }
      term.dispose();
    };
  }, [containerName, kubeconfig, namespace, podName]);

  return (
    <div className="h-full w-full relative bg-[#0d0d0d] overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  );
}
