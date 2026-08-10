import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  attachAltBufferScrollHandler,
  attachTerminalClipboard,
  buildInitialShellCommand,
  createTerminalLinkHandler,
  getXtermTerminalOptions,
  hideXtermScrollbar,
  openTerminalLinkInNewTab,
  pastedImageFilename,
} from "@infrawrench/ui";
import { apiPost } from "@/lib/api";
import { trustPayloadFromFrame, type HostKeyTrustPayload } from "@/lib/host-key-trust";
import { useHostKeyTrust } from "@/lib/useHostKeyTrust";

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
   * This terminal hosts a coding agent (Claude Code/Codex) that scrolls
   * in-app: disable xterm scrollback and hide the scrollbar.
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
  // Connection state mirrored into a visually hidden live region so screen
  // readers announce it — the xterm buffer writes are not reliably read.
  const [statusMessage, setStatusMessage] = useState("");
  const { promptIfNeeded, dialog } = useHostKeyTrust(orgId ?? "");

  useEffect(() => {
    let term: import("@xterm/xterm").Terminal | null = null;
    let disposed = false;
    let connected = false;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      if (!containerRef.current || disposed) return;

      // URLs printed by the remote host (a `gh auth login` device-code page,
      // the `t3 connect link` authorization URL) open in a new browser tab.
      // The handler validates the scheme first — terminal output is
      // remote-controlled text.
      const linkHandler = createTerminalLinkHandler({
        openExternal: openTerminalLinkInNewTab,
      });
      term = new Terminal({
        ...getXtermTerminalOptions(agentTerminal ? { scrollback: 0 } : undefined),
        linkHandler,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      // OSC 8 hyperlinks are handled by `linkHandler` above; this addon finds
      // bare URLs in the buffer and routes clicks through the same policy.
      term.loadAddon(new WebLinksAddon((event, uri) => linkHandler.activate(event, uri)));
      term.open(containerRef.current);
      if (agentTerminal) hideXtermScrollbar(containerRef.current);

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
      const altScroll = attachAltBufferScrollHandler(term, sendToShell);

      // The proxy reports an untrusted/changed host key as a structured
      // ssh:error frame. Show the same trust dialog the HTTP SSH surfaces use
      // and, once the pin is recorded, reconnect on a fresh socket + token
      // (ws tokens are one-time and the proxy tears the session down when the
      // verifier rejects).
      const handleTrustRequired = async (payload: HostKeyTrustPayload) => {
        const accepted = await promptIfNeeded(payload);
        if (disposed) return;
        if (!accepted) {
          term?.write(`\r\n\x1b[31m${payload.message}\x1b[0m\r\n`);
          setStatusMessage(payload.message);
          return;
        }
        try {
          const fresh = await apiPost<{ token: string }>(`/api/org/${orgId}/ws-token`, {});
          if (disposed) return;
          term?.write(`\x1b[90mHost key trusted — reconnecting…\x1b[0m\r\n`);
          setStatusMessage("Host key trusted — reconnecting…");
          wsRef.current?.close();
          openSocket(fresh.token);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          term?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
          setStatusMessage(message);
        }
      };

      const openSocket = (wsToken: string) => {
        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(wsToken)}`,
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
            code?: string;
            kind?: string;
            host?: string;
            port?: number;
            presentedFingerprint?: string;
            storedFingerprint?: string | null;
          };

          switch (msg.type) {
            case "ssh:connected":
              connected = true;
              setStatusMessage("Connected");
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
            case "ssh:error": {
              const trustPayload = trustPayloadFromFrame(msg);
              if (trustPayload && orgId) {
                void handleTrustRequired(trustPayload);
              } else {
                term?.write(`\r\n\x1b[31m${msg.error ?? "Connection error"}\x1b[0m\r\n`);
                setStatusMessage(msg.error ?? "Connection error");
              }
              break;
            }
            case "ssh:closed":
              connected = false;
              term?.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n");
              setStatusMessage("Connection closed");
              break;
          }
        };

        ws.onerror = () => {
          term?.write("\r\n\x1b[31mWebSocket connection failed\x1b[0m\r\n");
          setStatusMessage("WebSocket connection failed");
        };
      };

      requestAnimationFrame(() => {
        if (disposed || !term) return;
        fitAddon.fit();

        const connectLabel = sshHost && sshUsername ? `${sshUsername}@${sshHost}:22` : "SSH";
        term.write(`\x1b[90mConnecting to \x1b[0m${connectLabel}\x1b[90m…\x1b[0m\r\n`);
        setStatusMessage(`Connecting to ${connectLabel}…`);

        openSocket(token);
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
    promptIfNeeded,
  ]);

  return (
    <div className="h-full w-full relative bg-[var(--color-terminal-bg)] overflow-hidden">
      <div role="status" aria-live="polite" className="sr-only">
        {statusMessage}
      </div>
      <div ref={containerRef} className="absolute inset-0 p-2" />
      {dialog}
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
