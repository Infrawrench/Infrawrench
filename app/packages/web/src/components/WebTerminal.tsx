import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  attachAltBufferScrollHandler,
  attachTerminalClipboard,
  getXtermTerminalOptions,
  pastedImageFilename,
} from "@infrawrench/ui";

interface WebTerminalProps {
  accountId: string;
  resourceId?: string;
  token: string;
  /** Enables image paste — pasted clipboard images upload via the org's SFTP route. */
  orgId?: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
  agentForward?: boolean;
  initialCommand?: string | undefined;
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

export function WebTerminal({
  accountId,
  resourceId,
  token,
  orgId,
  sshKeyId,
  sshHost,
  sshUsername,
  agentForward,
  initialCommand,
  initialCwd,
  agentTerminal,
}: WebTerminalProps) {
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

      // Pasting an image uploads it to the remote host over SFTP and pastes
      // the resulting remote path into the shell. Needs orgId for the
      // org-scoped upload route; without it, image paste is disabled.
      const clipboard = attachTerminalClipboard(term, {
        onPasteImage: async (image) => {
          if (!orgId) return null;
          const filename = pastedImageFilename(image.mime, new Date());
          const remotePath = `/tmp/${filename}`;
          try {
            const formData = new FormData();
            formData.append("accountId", accountId);
            formData.append("remotePath", remotePath);
            formData.append("file", new Blob([image.data], { type: image.mime }), filename);
            if (sshKeyId) formData.append("sshKeyId", sshKeyId);
            if (sshHost) formData.append("sshHost", sshHost);
            if (sshUsername) formData.append("sshUsername", sshUsername);
            const resp = await fetch(`/api/org/${orgId}/v1/sftp/upload`, {
              method: "POST",
              credentials: "include",
              body: formData,
            });
            if (!resp.ok) throw new Error(await resp.text());
            return remotePath;
          } catch (err) {
            term?.write(
              `\r\n\x1b[31mImage paste failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`,
            );
            return null;
          }
        },
      });

      const sendToShell = (data: string) => {
        if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "ssh:data", data: base64EncodeUtf8(data) }));
        }
      };
      // Guard terminal input — only forward after SSH session is ready.
      // Mirrors desktop's `if (shellId)` guard: xterm.js auto-sends device
      // attribute responses which must not reach the shell before it's ready.
      const onData = term.onData(sendToShell);
      const altScroll = attachAltBufferScrollHandler(
        term,
        sendToShell,
        agentTerminal ? { wheelKeys: "page" } : undefined,
      );

      requestAnimationFrame(() => {
        if (disposed || !term) return;
        fitAddon.fit();

        const connectLabel = sshHost && sshUsername ? `${sshUsername}@${sshHost}:22` : "SSH";
        term.write(`\x1b[90mConnecting to \x1b[0m${connectLabel}\x1b[90m…\x1b[0m\r\n`);

        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "ssh:open",
              accountId,
              resourceId,
              sshKeyId,
              sshHost,
              sshUsername,
              cols: term!.cols,
              rows: term!.rows,
              ...(agentForward ? { agentForward: true } : {}),
            }),
          );
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
              {
                const launchCommand = buildInitialShellCommand(initialCommand, initialCwd);
                if (launchCommand && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(
                    JSON.stringify({
                      type: "ssh:data",
                      data: base64EncodeUtf8(`${launchCommand}\n`),
                    }),
                  );
                }
              }
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
          wsRef.current.send(
            JSON.stringify({ type: "ssh:resize", cols: term.cols, rows: term.rows }),
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
  }, [
    accountId,
    resourceId,
    token,
    orgId,
    sshKeyId,
    sshHost,
    sshUsername,
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

// btoa alone throws on code points above U+00FF, so encode to UTF-8 bytes first.
// The server side decodes with Buffer.from(data, "base64") and writes the raw
// bytes to the SSH stream, matching desktop's direct UTF-8 writes.
export function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
