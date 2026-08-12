/**
 * A guest's view of somebody else's live terminal.
 *
 * The mirror image of `WebTerminal`: it opens a socket, sends
 * `console:attach`, and renders `console:data`. What it never does is decide
 * whether this person may type. It sends keystrokes when the server has told
 * it this participant is the driver — and when it is wrong about that, the
 * server drops them. The UI state exists so the observer is not confused, not
 * so that they are contained.
 *
 * Two behaviours worth reading the code for:
 *
 * - **The retry on `console_not_here`.** The pty lives in one web replica's
 *   memory and the ingress hashes `?sid=` to reach it. When that misses — a
 *   rolling deploy, a proxy that does not honour the annotation — the socket
 *   is reopened on a fresh ws token, which rehashes. Bounded, and it says so
 *   when it gives up rather than showing an empty terminal forever.
 * - **Letterboxing.** The pty's geometry is the driver's. This terminal is set
 *   to that grid and scaled to fit, never reflowed — an observer watching a
 *   full-screen editor has to be looking at the same screen the driver is.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import {
  attachTerminalClipboard,
  createTerminalLinkHandler,
  getXtermTerminalOptions,
  openTerminalLinkInNewTab,
} from "@infrawrench/ui";
import {
  currentDriver,
  letterboxScale,
  type SharedConsoleParticipant,
  type SharedConsoleSummary,
} from "@infrawrench/client-core";

import { apiPost } from "@/lib/api";
import { base64EncodeUtf8 } from "./WebTerminal";
import { RoleBadge } from "./SharedConsolePanel";

/**
 * How many times a guest re-dials before giving up on reaching the replica
 * holding the pty.
 *
 * Each attempt is an independent hash, so with a small replica set the odds of
 * missing four times running are negligible; with a large one the affinity
 * annotation is doing the work and a miss means something is actually wrong.
 * Either way, four failures is the point at which retrying stops being
 * recovery and starts being a spinner.
 */
const MAX_ATTACH_ATTEMPTS = 4;

interface SharedConsoleViewerProps {
  orgId: string;
  sharedConsoleId: string;
  routingKey: string;
  wsToken: string;
  initialShare: SharedConsoleSummary;
  initialParticipants: SharedConsoleParticipant[];
  youParticipantId: string;
  onLeave: () => void;
}

export function SharedConsoleViewer({
  orgId,
  sharedConsoleId,
  routingKey,
  wsToken,
  initialShare,
  initialParticipants,
  youParticipantId,
  onLeave,
}: SharedConsoleViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [share, setShare] = useState(initialShare);
  const [participants, setParticipants] = useState(initialParticipants);
  const [status, setStatus] = useState("Connecting…");
  const [detached, setDetached] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const you = participants.find((p) => p.id === youParticipantId) ?? null;
  const driver = currentDriver(participants);
  const youAreDriver = driver?.id === youParticipantId;

  useEffect(() => {
    let term: import("@xterm/xterm").Terminal | null = null;
    let disposed = false;
    let attempts = 0;
    let ptySize: { cols: number; rows: number } | null = null;
    let amDriver = false;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      if (!containerRef.current || disposed) return;
      const linkHandler = createTerminalLinkHandler({ openExternal: openTerminalLinkInNewTab });
      term = new Terminal({ ...getXtermTerminalOptions(), linkHandler });
      term.open(containerRef.current);
      const clipboard = attachTerminalClipboard(term);

      const applySize = () => {
        const element = term?.element;
        const container = containerRef.current;
        if (!term || !ptySize || !element || !container) return;
        if (term.cols !== ptySize.cols || term.rows !== ptySize.rows) {
          term.resize(ptySize.cols, ptySize.rows);
        }
        element.style.transformOrigin = "top left";
        const scale = letterboxScale(
          { width: element.offsetWidth, height: element.offsetHeight },
          { width: container.clientWidth, height: container.clientHeight },
        );
        element.style.transform = scale < 1 ? `scale(${scale})` : "";
      };

      // Sent whatever this client believes about its own role. The server
      // decides; a frame it does not want costs one dropped buffer.
      const onData = term.onData((data) => {
        if (!amDriver) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({ type: "console:input", data: base64EncodeUtf8(data) }));
      });

      const openSocket = (freshToken: string) => {
        attempts++;
        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        // The affinity hint: the same `sid` the sharer's own socket carries, so
        // the ingress hashes this upgrade onto the replica holding the pty.
        const ws = new WebSocket(
          `${wsProtocol}//${window.location.host}/api/ws?token=${encodeURIComponent(freshToken)}` +
            `&sid=${encodeURIComponent(routingKey)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => ws.send(JSON.stringify({ type: "console:attach", sharedConsoleId }));

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            data?: string;
            cols?: number;
            rows?: number;
            code?: string;
            error?: string;
            message?: string;
            reason?: string;
            role?: "observer" | "driver";
            youAreDriver?: boolean;
            ptySize?: { cols: number; rows: number };
            share?: SharedConsoleSummary;
            participants?: SharedConsoleParticipant[];
          };
          switch (msg.type) {
            case "console:attached":
              setStatus("Watching");
              amDriver = msg.role === "driver";
              if (msg.ptySize) {
                ptySize = msg.ptySize;
                applySize();
              }
              break;
            case "console:data":
              if (msg.data && term) {
                term.write(Uint8Array.from(atob(msg.data), (ch) => ch.charCodeAt(0)));
              }
              break;
            case "console:state":
              if (msg.share) setShare(msg.share);
              if (msg.participants) {
                setParticipants(msg.participants);
                amDriver =
                  msg.participants.find((p) => p.id === youParticipantId)?.role === "driver";
              }
              break;
            case "console:pty-size":
              if (msg.cols && msg.rows) {
                ptySize = { cols: msg.cols, rows: msg.rows };
                applySize();
              }
              break;
            case "console:detached":
            case "console:ended":
              setDetached(msg.message ?? "This session ended.");
              setStatus("Disconnected");
              break;
            case "console:error":
              if (msg.code === "console_not_here" && attempts < MAX_ATTACH_ATTEMPTS) {
                // Reconnect on a fresh token, which rehashes at the ingress.
                setStatus("Finding this session…");
                void apiPost<{ token: string }>(`/api/org/${orgId}/ws-token`, {})
                  .then(({ token }) => {
                    if (!disposed) openSocket(token);
                  })
                  .catch(() => setDetached("Could not reach this session."));
                return;
              }
              setDetached(
                msg.code === "console_not_here"
                  ? "This session is being served by a server instance we could not reach. Ask the sharer to reopen the terminal and send a new link."
                  : (msg.error ?? "Could not join that session."),
              );
              setStatus("Disconnected");
              break;
          }
        };

        ws.onerror = () => setStatus("Connection failed");
      };

      openSocket(wsToken);

      const ro = new ResizeObserver(() => applySize());
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        onData.dispose();
        clipboard.dispose();
      };
    }

    const cleanup = init();
    return () => {
      disposed = true;
      void cleanup?.then((fn) => fn?.());
      wsRef.current?.close();
      term?.dispose();
    };
  }, [orgId, sharedConsoleId, routingKey, wsToken, youParticipantId]);

  const base = `/api/org/${orgId}/shared-consoles/${sharedConsoleId}`;

  const requestDriver = useCallback(async () => {
    setBusy(true);
    try {
      await apiPost(`${base}/request-driver`, {});
    } finally {
      setBusy(false);
    }
  }, [base]);

  const leave = useCallback(async () => {
    setBusy(true);
    try {
      await apiPost(`${base}/leave`, {});
    } finally {
      setBusy(false);
      onLeave();
    }
  }, [base, onLeave]);

  return (
    <div className="flex h-screen flex-col bg-[var(--color-terminal-bg)]">
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-border/60 bg-surface">
        <span className="font-mono text-xs text-on-surface">
          {share.username}@{share.host}
        </span>
        <span className="text-[11px] text-on-surface-tertiary">
          shared by {share.ownerName ?? "a colleague"} · {status}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          {participants
            .filter((p) => p.status === "joined")
            .map((p) => (
              <span
                key={p.id}
                className="flex items-center gap-1 text-[11px] text-on-surface-muted"
              >
                {p.userName ?? p.userId}
                {p.id === youParticipantId ? " (you)" : ""}
                <RoleBadge role={p.role} />
              </span>
            ))}
        </div>
        {share.allowHandover && you && !youAreDriver && (
          <button
            type="button"
            onClick={requestDriver}
            disabled={busy || Boolean(you.driverRequestedAt)}
            className="px-2 py-1 text-[11px] border border-border rounded-lg text-on-surface-secondary hover:bg-surface-overlay disabled:opacity-50"
          >
            {you.driverRequestedAt ? "Asked for keyboard" : "Ask for keyboard"}
          </button>
        )}
        <button
          type="button"
          onClick={leave}
          disabled={busy}
          className="px-2 py-1 text-[11px] border border-border rounded-lg text-on-surface-secondary hover:bg-surface-overlay disabled:opacity-50"
        >
          Leave
        </button>
      </div>

      {/* The one honest thing the read-only banner can say: it is the server
          that is dropping the keystrokes, not this page. */}
      {!youAreDriver && !detached && (
        <div className="shrink-0 px-3 py-1 text-[11px] text-on-surface-tertiary bg-surface/60 border-b border-border/40">
          Read-only — your keystrokes are dropped by the server, and the terminal below is shown at
          the driver&rsquo;s window size.
        </div>
      )}

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div role="status" aria-live="polite" className="sr-only">
          {detached ?? status}
        </div>
        <div ref={containerRef} className="absolute inset-0 p-2" />
        {detached && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6 text-center">
            <div className="max-w-md space-y-3">
              <p className="text-sm text-on-surface">{detached}</p>
              <button
                type="button"
                onClick={onLeave}
                className="px-3 py-1.5 text-sm font-medium border border-border rounded-lg text-on-surface-secondary hover:bg-surface-overlay"
              >
                Back to the dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
