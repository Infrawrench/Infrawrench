import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme, useUIStore } from "@infrawrench/ui";
import type { KeySource } from "../lib/ssh-key-source";
import { openSshShell, type SshShellHandle } from "../lib/ssh-dispatch";

interface SshTerminalProps {
  host: string;
  port: number;
  username: string;
  /** Raw PEM — required when keySource is undefined or a local type. */
  privateKey: string;
  /** Selected key source. When kind is "cloud", dispatches through the WS proxy. */
  keySource?: KeySource | null;
  /** Required for cloud dispatch — identifies the account the WS proxy should SSH from. */
  accountId?: string;
  /** Optional resource id — helps the cloud proxy resolve a default SSH config. */
  resourceId?: string;
}

export function SshTerminal({
  host,
  port,
  username,
  privateKey,
  keySource,
  accountId,
  resourceId,
}: SshTerminalProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
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

    let shell: SshShellHandle | null = null;
    let disposed = false;

    requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();

      term.write(
        "\x1b[90mConnecting to \x1b[0m" + `${username}@${host}:${port}` + "\x1b[90m…\x1b[0m\r\n",
      );

      const cloudSource = keySource?.type === "cloud" ? keySource : null;
      const openPromise =
        cloudSource && accountId && activeCloudOrgId
          ? openSshShell({
              mode: "cloud",
              orgId: activeCloudOrgId,
              keySource: cloudSource,
              accountId,
              ...(resourceId ? { resourceId } : {}),
              host,
              port,
              username,
              cols: term.cols,
              rows: term.rows,
            })
          : openSshShell({
              mode: "local",
              host,
              port,
              username,
              privateKey,
              cols: term.cols,
              rows: term.rows,
            });

      openPromise
        .then((handle) => {
          if (disposed) {
            handle.kill();
            return;
          }
          shell = handle;
          handle.onData((data) => term.write(data));
          handle.onExit(() => term.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n"));
          handle.onError((err) => term.write(`\r\n\x1b[31m${err}\x1b[0m\r\n`));
        })
        .catch((err: unknown) => {
          term.write(`\r\n\x1b[31mFailed: ${String(err)}\x1b[0m\r\n`);
        });
    });

    const onData = term.onData((data) => {
      shell?.write(data);
    });

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      shell?.resize(term.cols, term.rows);
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      onData.dispose();
      shell?.kill();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, username, privateKey, keySource?.type, accountId, resourceId, activeCloudOrgId]);

  return (
    <div className="h-full w-full relative bg-[var(--color-terminal-bg)] overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  );
}
