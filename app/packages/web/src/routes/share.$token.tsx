/**
 * The join screen for a shared console.
 *
 * Outside the org shell, like `/invite/$token`, because the visitor arrives
 * from a chat message rather than from inside the app. Two deliberate
 * properties:
 *
 * - **It says what you are about to do before you do it.** Which host, whose
 *   session, whether you would be able to type. Somebody clicking a link in a
 *   channel should not discover which production box they landed on by reading
 *   the prompt.
 * - **It resolves the organization from the token, not from the URL.** A join
 *   link carries no org id, so the visitor's memberships are enumerated and
 *   the invite is previewed against each until one recognises it. That means a
 *   person in three orgs pastes one link and it works, and it means a link
 *   cannot be made to point at an org the visitor is not in.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  currentDriver,
  type SharedConsoleInvitePreview,
  type SharedConsoleJoined,
  type SharedConsoleParticipant,
  type SharedConsoleSummary,
} from "@infrawrench/client-core";

import { apiGet, apiPost } from "@/lib/api";
import { SharedConsoleViewer } from "@/components/SharedConsoleViewer";

export const Route = createFileRoute("/share/$token")({
  component: SharedConsoleJoinPage,
});

type Phase = "resolving" | "preview" | "joining" | "joined" | "error";

function SharedConsoleJoinPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("resolving");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SharedConsoleInvitePreview | null>(null);
  const [joined, setJoined] = useState<SharedConsoleJoined | null>(null);
  const [wsToken, setWsToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolved = useRef(false);

  useEffect(() => {
    if (resolved.current) return;
    resolved.current = true;
    void (async () => {
      try {
        const orgs = await apiGet<Array<{ id: string }>>("/api/auth/orgs");
        for (const org of orgs) {
          try {
            const found = await apiGet<SharedConsoleInvitePreview>(
              `/api/org/${org.id}/shared-consoles/invites/${encodeURIComponent(token)}`,
            );
            setOrgId(org.id);
            setPreview(found);
            setPhase("preview");
            return;
          } catch {
            // 404 here means "not this org's link" — keep looking. A genuine
            // refusal (no permission, expired) comes back 200 with
            // `joinable: false` and lands above, so this catch only swallows
            // the search itself.
          }
        }
        setError("That link is not valid, or the session it points at has ended.");
        setPhase("error");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not check that link.");
        setPhase("error");
      }
    })();
  }, [token]);

  const join = useCallback(async () => {
    if (!orgId || !preview) return;
    setPhase("joining");
    setError(null);
    try {
      const result = await apiPost<SharedConsoleJoined>(
        `/api/org/${orgId}/shared-consoles/${preview.share.id}/join`,
        { token },
      );
      const ws = await apiPost<{ token: string }>(`/api/org/${orgId}/ws-token`, {});
      setJoined(result);
      setWsToken(ws.token);
      setPhase("joined");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join that session.");
      setPhase("preview");
    }
  }, [orgId, preview, token]);

  if (phase === "joined" && joined && wsToken && orgId) {
    return (
      <SharedConsoleViewer
        orgId={orgId}
        sharedConsoleId={joined.share.id}
        routingKey={joined.routingKey}
        wsToken={wsToken}
        initialShare={joined.share}
        initialParticipants={joined.participants}
        youParticipantId={joined.you.id}
        onLeave={() => {
          void navigate({ to: "/org/$orgId", params: { orgId } });
        }}
      />
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-md border border-border rounded-xl p-6 space-y-4">
        {phase === "resolving" ? (
          <p className="text-sm text-on-surface-tertiary animate-pulse">Checking that link…</p>
        ) : phase === "error" || !preview ? (
          <>
            <h1 className="text-base font-semibold text-on-surface">Link not valid</h1>
            <p className="text-sm text-on-surface-tertiary">{error}</p>
          </>
        ) : (
          <>
            <h1 className="text-base font-semibold text-on-surface">Join a shared terminal</h1>
            <SessionSummary share={preview.share} participants={[]} />
            <p className="text-xs text-on-surface-tertiary leading-relaxed">
              You will see everything happening in this session live. You start as an{" "}
              <strong>observer</strong> — your keystrokes are dropped by the server, not merely
              hidden here —{" "}
              {preview.share.allowHandover
                ? "and the person sharing can hand you the keyboard."
                : "and this session was shared read-only, so the keyboard cannot move."}{" "}
              Your join, and anything you do afterwards, is written to this organization's audit log
              {preview.share.recordingId ? " and to the session recording" : ""}.
            </p>
            {error && (
              <p className="text-xs text-red-300 border border-red-500/30 bg-red-500/10 rounded-lg p-2">
                {error}
              </p>
            )}
            {preview.joinable ? (
              <button
                type="button"
                onClick={join}
                disabled={phase === "joining"}
                className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {phase === "joining"
                  ? "Joining…"
                  : preview.rejoin
                    ? "Rejoin this session"
                    : "Join as observer"}
              </button>
            ) : (
              <p className="text-sm text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded-lg p-3">
                {preview.error ?? "You cannot join this session."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SessionSummary({
  share,
  participants,
}: {
  share: SharedConsoleSummary;
  participants: SharedConsoleParticipant[];
}) {
  const driver = currentDriver(participants);
  return (
    <div className="border border-border rounded-lg p-3 space-y-1 text-sm">
      <div className="font-mono text-on-surface">
        {share.username}@{share.host}
        {share.port !== 22 ? `:${share.port}` : ""}
      </div>
      <div className="text-xs text-on-surface-tertiary">
        shared by {share.ownerName ?? "a colleague"}
        {driver ? ` · ${driver.userName ?? driver.userId} is driving` : ""}
      </div>
      {!share.allowHandover && (
        <div className="text-xs text-on-surface-tertiary">read-only share</div>
      )}
    </div>
  );
}
