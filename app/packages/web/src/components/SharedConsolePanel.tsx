/**
 * The Share affordance beside a live web SSH terminal.
 *
 * Two jobs, and it is worth being explicit that only one of them is a control:
 *
 * - **Presentation.** Who is on the console, who has the keyboard, whose turn
 *   it is to be asked. That is all this component decides.
 * - **Requests.** Every mutation is an HTTP call the server re-authorises from
 *   scratch. Nothing here is a security boundary: the observer's terminal is
 *   read-only because the *server* drops their keystrokes, not because this
 *   file renders a padlock. If everything in this file were deleted, the rules
 *   would be identical.
 *
 * The share state itself arrives over the terminal's own WebSocket (the server
 * pushes `console:state` on every change), so this panel never polls and
 * everyone sees the same participant list at the same moment.
 */
import { useCallback, useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";

import {
  currentDriver,
  formatInviteExpiry,
  type SharedConsoleParticipant,
  type SharedConsoleSummary,
} from "@infrawrench/client-core";
import { Modal } from "@infrawrench/ui";

import { apiDelete, apiPost } from "@/lib/api";
import type { WebTerminalSession } from "./WebTerminal";

const PRIMARY_BUTTON =
  "px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors";
const SECONDARY_BUTTON =
  "px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors";
const DANGER_BUTTON =
  "px-3 py-1.5 text-sm font-medium border border-red-500/40 text-danger hover:bg-red-500/10 disabled:opacity-50 rounded-lg transition-colors";

interface SharedConsolePanelProps {
  orgId: string;
  /** The live pty, once the terminal has one. Null before the shell opens. */
  session: WebTerminalSession | null;
  share: SharedConsoleSummary | null;
  participants: SharedConsoleParticipant[];
  /** This browser's participant row, so "you" can be marked and gated. */
  youParticipantId: string | null;
}

export function SharedConsolePanel({
  orgId,
  session,
  share,
  participants,
  youParticipantId,
}: SharedConsolePanelProps) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [allowHandover, setAllowHandover] = useState(true);
  // Re-rendered on a timer purely so the invite countdown ticks; the share
  // state itself is pushed, never polled.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!open || !share?.inviteExpiresAt) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [open, share?.inviteExpiresAt]);

  // A fresh invite is shown once and then forgotten: only its digest is
  // stored, so keeping it in state after the dialog closes would be the one
  // copy of a live credential sitting in a component nobody is looking at.
  useEffect(() => {
    if (!open) {
      setInviteToken(null);
      setCopied(false);
    }
  }, [open]);

  const base = `/api/org/${orgId}/shared-consoles`;

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const startShare = () =>
    run(async () => {
      if (!session) throw new Error(gt("The terminal is not connected yet."));
      const created = await apiPost<{ inviteToken: string }>(base, {
        liveConsoleId: session.liveConsoleId,
        routingKey: session.routingKey,
        allowHandover,
      });
      setInviteToken(created.inviteToken);
    });

  const newInvite = () =>
    run(async () => {
      if (!share) return;
      const minted = await apiPost<{ inviteToken: string }>(`${base}/${share.id}/invites`, {});
      setInviteToken(minted.inviteToken);
      setCopied(false);
    });

  const withdrawInvite = () =>
    run(async () => {
      if (!share) return;
      await apiDelete(`${base}/${share.id}/invites`);
      setInviteToken(null);
    });

  const handover = (participantId: string) =>
    run(async () => {
      if (!share) return;
      await apiPost(`${base}/${share.id}/handover`, { participantId });
    });

  const removeParticipant = (participantId: string) =>
    run(async () => {
      if (!share) return;
      await apiDelete(`${base}/${share.id}/participants/${participantId}`);
    });

  const revoke = () =>
    run(async () => {
      if (!share) return;
      await apiDelete(`${base}/${share.id}`);
      setOpen(false);
    });

  const copyLink = async () => {
    if (!inviteToken) return;
    const url = `${window.location.origin}/share/${inviteToken}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(gt("Could not reach the clipboard — select the link and copy it manually."));
    }
  };

  const driver = currentDriver(participants);
  const you = participants.find((p) => p.id === youParticipantId) ?? null;
  const youAreOwner = share !== null && you !== null && share.ownerUserId === you.userId;
  const youAreDriver = driver !== null && driver.id === youParticipantId;
  const joined = participants.filter((p) => p.status === "joined");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!session}
        className={`${share ? PRIMARY_BUTTON : SECONDARY_BUTTON} disabled:opacity-40`}
        title={
          session
            ? gt("Share this live session with a colleague")
            : gt("Available once the terminal is connected")
        }
      >
        {share ? gt("Shared · {count}", { count: joined.length }) : gt("Share")}
      </button>

      {open && (
        <Modal ariaLabel={gt("Share this console")} onClose={() => setOpen(false)}>
          <div className="w-[34rem] max-w-full p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-on-surface">
                {gt("Share this console")}
              </h2>
              <p className="mt-1 text-xs text-on-surface-tertiary">
                {share ? (
                  <T>
                    <Var>
                      {share.username}@{share.host}
                    </Var>{" "}
                    — everyone here sees this terminal live.
                  </T>
                ) : (
                  gt(
                    "Invite a colleague to watch this session, and optionally hand them the keyboard.",
                  )
                )}
              </p>
            </div>

            {/* The trust statement, in front of the person doing the sharing.
                It is not decoration: the single most common misconception
                about a link like this is that the link is the access. */}
            <T>
              <p className="text-xs text-on-surface-tertiary border border-border rounded-lg p-3 leading-relaxed">
                Anyone you invite must already be a member of this organization with permission to
                open a terminal on this resource — the link says <em>which</em> session, never{" "}
                <em>whether</em>. Every join, handover and departure is written to the audit log,
                and if this organization records sessions, everyone on the console is named in the
                recording.
              </p>
            </T>

            {error && (
              <p className="text-xs text-danger border border-red-500/30 bg-red-500/10 rounded-lg p-2">
                {error}
              </p>
            )}

            {!share ? (
              <div className="space-y-3">
                <label className="flex items-start gap-2 text-xs text-on-surface-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allowHandover}
                    onChange={(e) => setAllowHandover(e.target.checked)}
                    className="mt-0.5 accent-blue-600"
                  />
                  <T>
                    <span>
                      Allow handing over the keyboard.
                      <span className="block text-on-surface-tertiary">
                        Leave this off for a strictly read-only share — nobody but you will ever be
                        able to type, and that is enforced on the server rather than inferred from
                        what anyone types.
                      </span>
                    </span>
                  </T>
                </label>
                <button
                  type="button"
                  onClick={startShare}
                  disabled={busy || !session}
                  className={PRIMARY_BUTTON}
                >
                  {busy ? gt("Sharing…") : gt("Start sharing")}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-on-surface-tertiary">
                    {gt("Invite link")}
                  </h3>
                  {inviteToken ? (
                    <div className="space-y-1">
                      <div className="flex gap-2">
                        <input
                          readOnly
                          value={`${window.location.origin}/share/${inviteToken}`}
                          onFocus={(e) => e.currentTarget.select()}
                          className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-xs font-mono text-on-surface"
                        />
                        <button type="button" onClick={copyLink} className={SECONDARY_BUTTON}>
                          {copied ? gt("Copied") : gt("Copy")}
                        </button>
                      </div>
                      <T>
                        <p className="text-[11px] text-on-surface-tertiary">
                          Shown once — <Var>{formatInviteExpiry(share.inviteExpiresAt)}</Var>, and
                          spent by the first person it admits. Mint another for a second guest.
                        </p>
                      </T>
                    </div>
                  ) : (
                    <p className="text-xs text-on-surface-tertiary">
                      {share.inviteConsumedAt
                        ? gt("The last invite has been used.")
                        : share.inviteExpiresAt
                          ? gt(
                              "An invite is outstanding (…{prefix}, {expiry}). The link itself cannot be shown again.",
                              {
                                prefix: share.inviteTokenPrefix,
                                expiry: formatInviteExpiry(share.inviteExpiresAt),
                              },
                            )
                          : gt("No open invite.")}
                    </p>
                  )}
                  {youAreOwner && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={newInvite}
                        disabled={busy}
                        className={SECONDARY_BUTTON}
                      >
                        {gt("New invite link")}
                      </button>
                      {share.inviteExpiresAt && (
                        <button
                          type="button"
                          onClick={withdrawInvite}
                          disabled={busy}
                          className={SECONDARY_BUTTON}
                        >
                          {gt("Withdraw")}
                        </button>
                      )}
                    </div>
                  )}
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-on-surface-tertiary">
                    {gt("On this console")}
                  </h3>
                  <ul className="divide-y divide-border border border-border rounded-lg">
                    {joined.map((p) => (
                      <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="flex-1 truncate text-sm text-on-surface">
                          {p.userName ?? p.userId}
                          {p.id === youParticipantId && (
                            <span className="text-on-surface-tertiary"> {gt("(you)")}</span>
                          )}
                          {share.ownerUserId === p.userId && (
                            <span className="text-on-surface-tertiary"> · {gt("sharer")}</span>
                          )}
                        </span>
                        <RoleBadge role={p.role} />
                        {p.driverRequestedAt && p.role !== "driver" && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-warning"
                            title={gt("They have asked for the keyboard")}
                          >
                            {gt("asked")}
                          </span>
                        )}
                        {(youAreDriver || youAreOwner) &&
                          p.role !== "driver" &&
                          share.allowHandover && (
                            <button
                              type="button"
                              onClick={() => handover(p.id)}
                              disabled={busy}
                              className="text-[11px] text-info hover:text-info-strong disabled:opacity-50"
                            >
                              {gt("give keyboard")}
                            </button>
                          )}
                        {youAreOwner && share.ownerUserId !== p.userId && (
                          <button
                            type="button"
                            onClick={() => removeParticipant(p.id)}
                            disabled={busy}
                            className="text-[11px] text-danger hover:text-danger-strong disabled:opacity-50"
                          >
                            {gt("remove")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {!share.allowHandover && (
                    <p className="text-[11px] text-on-surface-tertiary">
                      {gt("Read-only share — the keyboard cannot move.")}
                    </p>
                  )}
                </section>

                {youAreOwner && (
                  <div className="flex justify-between items-center pt-1">
                    <span className="text-[11px] text-on-surface-tertiary">
                      {gt("Revoking disconnects everyone. Your own session keeps running.")}
                    </span>
                    <button
                      type="button"
                      onClick={revoke}
                      disabled={busy}
                      className={DANGER_BUTTON}
                    >
                      {gt("Revoke share")}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button type="button" onClick={() => setOpen(false)} className={SECONDARY_BUTTON}>
                {gt("Close")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function RoleBadge({ role }: { role: "observer" | "driver" }) {
  const gt = useGT();
  return role === "driver" ? (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-success"
      title={gt("Holds the keyboard. Everyone else's keystrokes are dropped by the server.")}
    >
      {gt("driver")}
    </span>
  ) : (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-tertiary"
      title={gt("Watching. Their keystrokes never reach the host.")}
    >
      {gt("observer")}
    </span>
  );
}
