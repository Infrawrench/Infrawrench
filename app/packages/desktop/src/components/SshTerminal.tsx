import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  attachAltBufferScrollHandler,
  attachTerminalClipboard,
  getXtermTerminalOptions,
  useUIStore,
} from "@infrawrench/ui";
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
  /** Forward the local SSH agent to the remote host (local mode only). */
  agentForward?: boolean;
  /** Optional command to run after the shell connects. */
  initialCommand?: string | undefined;
  /** Optional remote directory to cd into before running initialCommand. */
  initialCwd?: string | undefined;
  /**
   * This terminal hosts a coding agent (Claude Code/Codex inside tmux). The
   * agent scrolls via native mouse reporting (tmux passes SGR mouse through);
   * when mouse tracking is off, the wheel falls back to PageUp/PageDown
   * instead of arrow keys, because arrows edit the agent's prompt/history
   * instead of scrolling.
   */
  agentTerminal?: boolean | undefined;
}

export function SshTerminal({
  host,
  port,
  username,
  privateKey,
  keySource,
  accountId,
  resourceId,
  agentForward,
  initialCommand,
  initialCwd,
  agentTerminal,
}: SshTerminalProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal(getXtermTerminalOptions());

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    const clipboard = attachTerminalClipboard(term);

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
              ...(agentForward ? { agentForward: true } : {}),
            })
          : openSshShell({
              mode: "local",
              host,
              port,
              username,
              privateKey,
              cols: term.cols,
              rows: term.rows,
              ...(agentForward ? { agentForward: true } : {}),
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
          const launchCommand = buildInitialShellCommand(initialCommand, initialCwd);
          if (launchCommand) {
            handle.write(`${launchCommand}\n`);
          }
        })
        .catch((err: unknown) => {
          term.write(`\r\n\x1b[31mFailed: ${String(err)}\x1b[0m\r\n`);
        });
    });

    const sendToShell = (data: string) => {
      shell?.write(data);
    };
    const onData = term.onData(sendToShell);
    const altScroll = attachAltBufferScrollHandler(
      term,
      sendToShell,
      agentTerminal ? { wheelKeys: "page" } : undefined,
    );

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
      altScroll.dispose();
      clipboard.dispose();
      shell?.kill();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    host,
    port,
    username,
    privateKey,
    keySource?.type,
    accountId,
    resourceId,
    activeCloudOrgId,
    initialCommand,
    initialCwd,
    agentTerminal,
  ]);

  return (
    <div className="h-full w-full relative bg-[var(--color-terminal-bg)] overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  );
}

export function buildInitialShellCommand(
  command: string | undefined,
  cwd: string | undefined,
): string {
  const trimmedCommand = command?.trim();
  if (!trimmedCommand) return "";
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) return trimmedCommand;
  return `cd ${shellQuote(trimmedCwd)} && ${trimmedCommand}`;
}

export function shellQuote(value: string): string {
  // Keep a leading `~` or `~/` bare so the shell still expands it, but
  // double-quote the remainder so spaces and metacharacters can't split
  // or inject into the command.
  if (value === "~") return "~";
  if (value.startsWith("~/")) {
    return `~/"${value.slice(2).replace(/(["\\$`])/g, "\\$1")}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
