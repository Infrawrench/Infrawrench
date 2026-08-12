import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  attachAltBufferScrollHandler,
  attachTerminalClipboard,
  buildInitialShellCommand,
  createTerminalLinkHandler,
  getTerminalContainerProps,
  getXtermTerminalOptions,
  hideXtermScrollbar,
  openTerminalLinkInNewTab,
  pastedImageFilename,
} from "@infrawrench/ui";
import {
  letterboxScale,
  mintRoutingKey,
  type SharedConsoleParticipant,
  type SharedConsoleSummary,
} from "@infrawrench/client-core";
import { apiPost } from "@/lib/api";
import { trustPayloadFromFrame, type HostKeyTrustPayload } from "@/lib/host-key-trust";
import { useHostKeyTrust } from "@/lib/useHostKeyTrust";

/**
 * What the terminal tells its parent about the session, so a Share panel can
 * be built beside it without the panel owning the socket.
 *
 * `liveConsoleId` is the pty's key in the holding replica's registry and is
 * what `POST /shared-consoles` names; `routingKey` is the affinity hint this
 * component minted before connecting. Both arrive only once the shell is open,
 * because until then there is nothing to share.
 */
export interface WebTerminalSession {
  liveConsoleId: string;
  routingKey: string;
}

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
  /** Fires once the shell is open, with what a Share panel needs. */
  onSession?: ((session: WebTerminalSession | null) => void) | undefined;
  /**
   * Live share state, pushed by the server over this same socket.
   *
   * The terminal receives it because the socket is here; it renders none of
   * it. Passing it up rather than up-and-back is what keeps the Share panel a
   * sibling of the terminal instead of a thing inside it.
   */
  onShareState?:
    | ((
        state: {
          share: SharedConsoleSummary;
          participants: SharedConsoleParticipant[];
          /** Which participant row is this browser's, so "you" can be marked. */
          youParticipantId: string | null;
        } | null,
      ) => void)
    | undefined;
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
  onSession,
  onShareState,
}: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Held in refs so a parent that passes a fresh closure each render does not
  // tear the socket down and reconnect the shell.
  const onSessionRef = useRef(onSession);
  const onShareStateRef = useRef(onShareState);
  onSessionRef.current = onSession;
  onShareStateRef.current = onShareState;
  // Connection state mirrored into a visually hidden live region so screen
  // readers announce it — the xterm buffer writes are not reliably read.
  const [statusMessage, setStatusMessage] = useState("");
  const { promptIfNeeded, dialog } = useHostKeyTrust(orgId ?? "");

  useEffect(() => {
    let term: import("@xterm/xterm").Terminal | null = null;
    let disposed = false;
    let connected = false;
    /** True once this session has been shared, so the letterbox rules apply. */
    let shared = false;
    /**
     * The geometry the server says the pty has, when it is not ours to choose.
     *
     * Null while this terminal is the driver (or unshared), in which case the
     * fit addon owns the size as it always did. Non-null after a handover:
     * one pty has one size, it is the driver's, and this window renders that
     * size scaled to fit rather than resizing the pty out from under them.
     */
    let driverSize: { cols: number; rows: number } | null = null;
    /** Minted before the socket opens — it has to be in the upgrade URL. */
    const routingKey = mintRoutingKey();

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

      /**
       * Render the driver's geometry, scaled to fit this window.
       *
       * `term.resize` to the announced size, then a CSS transform so the whole
       * grid fits — never a reflow. Reflowing would show a screen the driver
       * is not looking at, which for a full-screen editor is not a cosmetic
       * difference, and resizing the pty instead would let a spectator shrink
       * the terminal of the person actually fixing production.
       */
      const applyDriverSize = () => {
        const size = driverSize;
        const element = term?.element;
        const container = containerRef.current;
        if (!term || !size || !element || !container) return;
        if (term.cols !== size.cols || term.rows !== size.rows) {
          term.resize(size.cols, size.rows);
        }
        element.style.transformOrigin = "top left";
        // Measured after the resize so the numbers describe the new grid.
        const scale = letterboxScale(
          { width: element.offsetWidth, height: element.offsetHeight },
          { width: container.clientWidth, height: container.clientHeight },
        );
        element.style.transform = scale < 1 ? `scale(${scale})` : "";
      };

      /** Undo the letterbox and go back to owning our own size. */
      const releaseDriverSize = () => {
        driverSize = null;
        if (term?.element) term.element.style.transform = "";
      };

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
        // `sid` is the shared-console affinity hint. It is on every terminal's
        // URL, not only shared ones, because the decision to share comes later
        // than the connection and the hash has to have been stable all along.
        // For an unshared session nothing else ever asks for it.
        const ws = new WebSocket(
          `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(wsToken)}` +
            `&sid=${encodeURIComponent(routingKey)}`,
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
              routingKey,
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
            liveConsoleId?: string;
            cols?: number;
            rows?: number;
            share?: SharedConsoleSummary;
            participants?: SharedConsoleParticipant[];
            youParticipantId?: string | null;
            youAreDriver?: boolean;
          };

          switch (msg.type) {
            case "ssh:connected":
              connected = true;
              setStatusMessage("Connected");
              if (msg.liveConsoleId) {
                onSessionRef.current?.({ liveConsoleId: msg.liveConsoleId, routingKey });
              }
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
              onSessionRef.current?.(null);
              onShareStateRef.current?.(null);
              break;
            // Pushed by the server on every membership or role change, so the
            // Share panel never polls and everyone sees the same participant
            // list at the same moment.
            case "console:state":
              if (msg.share && msg.participants) {
                shared = true;
                onShareStateRef.current?.({
                  share: msg.share,
                  participants: msg.participants,
                  youParticipantId: msg.youParticipantId ?? null,
                });
              }
              break;
            case "console:ended":
              shared = false;
              releaseDriverSize();
              fitAddon.fit();
              onShareStateRef.current?.(null);
              break;
            // The pty is the driver's size. When somebody else is driving this
            // terminal renders that geometry scaled to fit; when it is ours,
            // the fit addon goes back to owning it.
            case "console:pty-size":
              if (msg.youAreDriver) {
                releaseDriverSize();
                fitAddon.fit();
              } else if (msg.cols && msg.rows && term) {
                driverSize = { cols: msg.cols, rows: msg.rows };
                applyDriverSize();
              }
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
        // Somebody else is driving: our window changed, the pty's did not.
        // Re-letterbox and say nothing — a resize frame from here would be
        // dropped server-side anyway, and sending one would be this client
        // asking for something it has been told it cannot have.
        if (driverSize) {
          applyDriverSize();
          const proposed = fitAddon.proposeDimensions();
          if (proposed && connected && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: "console:viewport",
                cols: proposed.cols,
                rows: proposed.rows,
              }),
            );
          }
          return;
        }
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
      <div
        ref={containerRef}
        className="absolute inset-0 p-2"
        // No `resourceId`/`accountId` fallback: without `sshHost` the server
        // takes the plugin-config branch and dials whatever `getSshConfig()`
        // reads out of the account credentials, so an id here would announce
        // something that is not the destination.
        {...getTerminalContainerProps({ kind: "ssh", host: sshHost, username: sshUsername })}
      />
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
