/**
 * Who may join a shared console, and who currently holds the keyboard.
 *
 * Everything in this file is a pure function of state that was read somewhere
 * else. That is deliberate and it is the whole reason the file exists: this
 * feature hands a second person a shell on someone else's production box, and
 * the rules that decide whether that is allowed should be readable, and
 * testable, without a database, a socket or a clock.
 *
 * The three rules, stated once here so they are not spread across four call
 * sites:
 *
 * 1. **The invite token is a locator, never a capability.** Holding one gets
 *    you as far as "there is a session at this address". Being admitted needs
 *    live org membership *and* the same permission a direct terminal session
 *    to that resource would need (`resources:execute`). A token that has
 *    expired, been withdrawn or already admitted somebody stops locating
 *    anything; a token that is perfectly valid still admits nobody who could
 *    not have opened the shell themselves.
 * 2. **Input comes from exactly one participant.** Not "the UI hides the
 *    keyboard for observers" — {@link evaluateInput} is called on the server
 *    for every inbound byte, and an observer's keystrokes are dropped there.
 *    A client that lies about its role changes nothing.
 * 3. **Authority is re-derived, never remembered.** A participant row records
 *    that somebody is attached, not that they may be. {@link evaluateAttached}
 *    is run against every participant on a sweep, so a person who loses the
 *    permission mid-session is detached rather than riding out the session on
 *    the check that passed when they joined.
 */

/** What a participant may do on the console. */
export type ParticipantRole = "observer" | "driver";

/** Whether a participant is currently on the console. */
export type ParticipantStatus = "joined" | "left" | "removed";

/** Lifecycle of the share itself. */
export type SharedConsoleStatus = "active" | "revoked" | "ended";

/**
 * The permission a direct terminal session to a resource requires.
 *
 * Joining a shared console requires exactly this and nothing else, which is
 * the point: a share is not a lesser capability that deserves a lesser gate.
 * Whoever is on the other end of the fan-out can take the keyboard (unless the
 * share is read-only) and is watching every byte either way, so the bar is the
 * bar for having the shell.
 */
export const CONSOLE_PERMISSION = "resources:execute";

/** The share, reduced to what a decision actually depends on. */
export interface SharedConsoleState {
  id: string;
  organizationId: string;
  status: SharedConsoleStatus;
  ownerUserId: string | null;
  allowHandover: boolean;
  inviteTokenHash: string | null;
  inviteExpiresAt: Date | null;
  inviteConsumedAt: Date | null;
}

/** One participant, reduced the same way. */
export interface ParticipantState {
  id: string;
  userId: string;
  role: ParticipantRole;
  status: ParticipantStatus;
}

/** The caller, as resolved from their session — never from what they sent. */
export interface CallerState {
  userId: string;
  organizationId: string;
  /** Live effective permissions, elevations included. */
  permissions: readonly string[];
}

/** Reasons a request against a share is refused, with an HTTP status each. */
export type ConsoleDenial =
  | { reason: "wrong-org"; status: 404; message: string }
  | { reason: "not-active"; status: 409; message: string }
  | { reason: "no-permission"; status: 403; message: string }
  | { reason: "invite-missing"; status: 403; message: string }
  | { reason: "invite-mismatch"; status: 403; message: string }
  | { reason: "invite-expired"; status: 403; message: string }
  | { reason: "invite-consumed"; status: 403; message: string }
  | { reason: "removed"; status: 403; message: string }
  | { reason: "not-participant"; status: 403; message: string }
  | { reason: "not-driver"; status: 403; message: string }
  | { reason: "handover-disabled"; status: 409; message: string }
  | { reason: "already-driver"; status: 409; message: string }
  | { reason: "not-owner"; status: 403; message: string };

export type Decision<T> = ({ ok: true } & T) | ({ ok: false } & ConsoleDenial);

const deny = (d: ConsoleDenial): Decision<never> => ({ ok: false, ...d });

/** Does this permission set include `required`, honouring `*` wildcards? */
function grants(permissions: readonly string[], required: string): boolean {
  const requiredParts = required.split(":");
  for (const entry of permissions) {
    if (entry === "*") return true;
    const parts = entry.split(":");
    if (parts.length !== requiredParts.length) continue;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "*" && parts[i] !== requiredParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * The gate every other check in this file starts with: right org, share still
 * live, caller still holds the terminal permission.
 *
 * A caller who was removed from the org resolves to an empty permission set
 * (see `permissions/resolver.ts`, which returns nothing at all for a
 * non-member), so lost membership and lost permission land on the same denial
 * — which is correct, because they are the same answer to the same question.
 */
function checkBaseline(
  share: SharedConsoleState,
  caller: CallerState,
): { ok: true } | ({ ok: false } & ConsoleDenial) {
  if (share.organizationId !== caller.organizationId) {
    return deny({
      reason: "wrong-org",
      status: 404,
      message: "Shared console not found.",
    });
  }
  if (share.status !== "active") {
    return deny({
      reason: "not-active",
      status: 409,
      message:
        share.status === "revoked" ? "This shared console was revoked." : "This session has ended.",
    });
  }
  if (!grants(caller.permissions, CONSOLE_PERMISSION)) {
    return deny({
      reason: "no-permission",
      status: 403,
      message:
        "Joining a shared console needs the same permission as opening a terminal " +
        `to this resource yourself (${CONSOLE_PERMISSION}).`,
    });
  }
  return { ok: true };
}

export interface JoinInput {
  share: SharedConsoleState;
  caller: CallerState;
  /** sha256 of the token the caller presented, or null if they presented none. */
  presentedTokenHash: string | null;
  /** The caller's existing row on this share, if they have been here before. */
  existing: ParticipantState | null;
  now: Date;
}

export type JoinDecision = Decision<{
  /** Rejoining an existing row rather than being admitted for the first time. */
  rejoin: boolean;
  /** True when this join burns the outstanding invite. */
  consumesInvite: boolean;
  /** What the participant's role should be after this join. */
  role: ParticipantRole;
}>;

/**
 * May this person attach to this share?
 *
 * The ordering matters. Permission is checked *before* the token, so a person
 * without `resources:execute` learns they lack the permission rather than
 * learning whether the token they were handed was any good — the token is not
 * the thing being tested, and an error message that grades it would make it
 * feel like it were.
 *
 * "Single-use-ish" lives here: an invite is consumed by the first person it
 * admits, and after that it locates nothing for anybody new. Someone already
 * on the share is readmitted on their own row without a token at all, so a
 * page reload, a flaky network or closing the tab by accident does not cost
 * them the session and does not oblige the owner to mint another invite. The
 * two behaviours look similar and are not: one is a capability being spent,
 * the other is a session being resumed by someone already inside it.
 */
export function evaluateJoin(input: JoinInput): JoinDecision {
  const { share, caller, presentedTokenHash, existing, now } = input;

  const baseline = checkBaseline(share, caller);
  if (!baseline.ok) return baseline;

  if (existing?.status === "removed") {
    return deny({
      reason: "removed",
      status: 403,
      message: "You were removed from this shared console. Ask for a fresh invite.",
    });
  }

  // Already inside: resume on the existing row, invite untouched. The owner's
  // own row takes this path too, which is why sharing your session never
  // requires you to redeem your own invite. (`removed` was refused above.)
  if (existing) {
    return { ok: true, rejoin: true, consumesInvite: false, role: existing.role };
  }

  if (!share.inviteTokenHash) {
    return deny({
      reason: share.inviteConsumedAt ? "invite-consumed" : "invite-missing",
      status: 403,
      message: share.inviteConsumedAt
        ? "That invite has already been used. Ask the sharer for a new link."
        : "This shared console has no open invite. Ask the sharer for a link.",
    });
  }
  if (!presentedTokenHash) {
    return deny({
      reason: "invite-missing",
      status: 403,
      message: "This shared console needs an invite link to join.",
    });
  }
  if (!constantTimeEqual(presentedTokenHash, share.inviteTokenHash)) {
    return deny({
      reason: "invite-mismatch",
      status: 403,
      message: "That invite link is not valid for this session.",
    });
  }
  if (share.inviteExpiresAt && share.inviteExpiresAt.getTime() <= now.getTime()) {
    return deny({
      reason: "invite-expired",
      status: 403,
      message: "That invite link has expired. Ask the sharer for a new one.",
    });
  }

  // A new person always starts as an observer, whatever the link said. Taking
  // the keyboard is a separate, explicit act by someone already holding it.
  return { ok: true, rejoin: false, consumesInvite: true, role: "observer" };
}

/**
 * Compare two hex digests without an early return on the first differing byte.
 *
 * The comparands here are sha256 digests of a 256-bit random token, so a
 * timing oracle on them is not a practical attack. It costs nothing to not
 * have one.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface InputInput {
  share: SharedConsoleState;
  participant: ParticipantState | null;
}

/**
 * May this participant's bytes reach the pty?
 *
 * Called per inbound frame on the server. Returns a plain boolean because
 * there is nothing useful to tell the sender: an observer's client already
 * knows it is an observer, and a client that does not is one we have no reason
 * to help. Dropped input is silent by design — echoing "denied" per keystroke
 * would be a fine way to turn a stuck caps-lock into a message flood.
 */
export function evaluateInput(input: InputInput): boolean {
  const { share, participant } = input;
  if (share.status !== "active") return false;
  if (!participant) return false;
  if (participant.status !== "joined") return false;
  return participant.role === "driver";
}

export interface HandoverInput {
  share: SharedConsoleState;
  /** Whoever is asking for the change to happen. */
  actor: CallerState;
  /** The actor's own participant row. */
  actorParticipant: ParticipantState | null;
  /** Who is to end up with the keyboard. */
  target: ParticipantState | null;
  /** The participant currently holding it, if any. */
  currentDriver: ParticipantState | null;
}

export type HandoverDecision = Decision<{
  /** Whether the actor is exercising the owner's forcible power. */
  forced: boolean;
  /** The participant to demote, if there is one. */
  demote: string | null;
  /** The participant to promote. */
  promote: string;
}>;

/**
 * May the keyboard move to `target`?
 *
 * Two people can authorise this and they authorise different things. The
 * **current driver** may hand over, because the keyboard is theirs to give.
 * The **owner** — whose credentials the session runs on, whose box it is —
 * may take it back or move it without asking, because they are the one who
 * carries the consequences and asking permission from someone who has stopped
 * responding is not a control, it is a hostage situation.
 *
 * Everyone else, including an observer who would very much like a turn, gets
 * `not-driver`; asking is {@link evaluateHandoverRequest}, which changes
 * nothing on its own.
 *
 * The race between two grants is *not* resolved here — this function is pure
 * and cannot see a concurrent transaction. It is resolved by the partial
 * unique index on `shared_console_participants`, and the caller turns the
 * resulting unique violation into "the keyboard already moved". This function
 * decides authority; the database decides order.
 */
export function evaluateHandover(input: HandoverInput): HandoverDecision {
  const { share, actor, actorParticipant, target, currentDriver } = input;

  const baseline = checkBaseline(share, actor);
  if (!baseline.ok) return baseline;

  if (!share.allowHandover) {
    return deny({
      reason: "handover-disabled",
      status: 409,
      message: "This console was shared read-only. Nobody but the sharer can type.",
    });
  }
  if (!target || target.status !== "joined") {
    return deny({
      reason: "not-participant",
      status: 403,
      message: "That person is not on this shared console.",
    });
  }
  if (target.role === "driver") {
    return deny({
      reason: "already-driver",
      status: 409,
      message: "They already have the keyboard.",
    });
  }

  const isOwner = share.ownerUserId !== null && share.ownerUserId === actor.userId;
  const isCurrentDriver =
    actorParticipant !== null &&
    actorParticipant.status === "joined" &&
    actorParticipant.role === "driver";

  if (!isOwner && !isCurrentDriver) {
    return deny({
      reason: "not-driver",
      status: 403,
      message: "Only the current driver or the person sharing can move the keyboard.",
    });
  }

  return {
    ok: true,
    forced: !isCurrentDriver,
    demote: currentDriver && currentDriver.id !== target.id ? currentDriver.id : null,
    promote: target.id,
  };
}

export interface HandoverRequestInput {
  share: SharedConsoleState;
  actor: CallerState;
  actorParticipant: ParticipantState | null;
}

/**
 * May this participant ask for the keyboard?
 *
 * Asking is not taking, so the bar is only "you are on this console, and it is
 * not read-only". The request is a flag on the participant row that the driver
 * and the owner see; it grants nothing until one of them acts on it.
 */
export function evaluateHandoverRequest(
  input: HandoverRequestInput,
): Decision<{ participantId: string }> {
  const { share, actor, actorParticipant } = input;

  const baseline = checkBaseline(share, actor);
  if (!baseline.ok) return baseline;

  if (!share.allowHandover) {
    return deny({
      reason: "handover-disabled",
      status: 409,
      message: "This console was shared read-only, so the keyboard cannot move.",
    });
  }
  if (!actorParticipant || actorParticipant.status !== "joined") {
    return deny({
      reason: "not-participant",
      status: 403,
      message: "You are not on this shared console.",
    });
  }
  if (actorParticipant.role === "driver") {
    return deny({
      reason: "already-driver",
      status: 409,
      message: "You already have the keyboard.",
    });
  }
  return { ok: true, participantId: actorParticipant.id };
}

export interface OwnerActionInput {
  share: SharedConsoleState;
  actor: CallerState;
  /**
   * True when the actor holds an org-wide administrative permission. An admin
   * can always pull the plug on a share they can see — a session nobody but
   * its own author can stop is not something a security team will accept.
   */
  isOrgAdmin: boolean;
}

/**
 * May this person revoke the share, eject participants or mint a fresh invite?
 *
 * The owner, or an org administrator. Note that revocation deliberately does
 * *not* require the console permission: taking access away must never be
 * gated on still holding the access, or an owner whose role was narrowed
 * mid-incident would be unable to close the session they opened. That is why
 * this does not go through {@link checkBaseline}.
 */
export function evaluateOwnerAction(input: OwnerActionInput): Decision<unknown> {
  const { share, actor, isOrgAdmin } = input;
  if (share.organizationId !== actor.organizationId) {
    return deny({ reason: "wrong-org", status: 404, message: "Shared console not found." });
  }
  const isOwner = share.ownerUserId !== null && share.ownerUserId === actor.userId;
  if (!isOwner && !isOrgAdmin) {
    return deny({
      reason: "not-owner",
      status: 403,
      message: "Only the person sharing this console, or an org administrator, can do that.",
    });
  }
  return { ok: true };
}

/** Why a participant was detached mid-session. */
export type DetachReason = "share-revoked" | "share-ended" | "permission-lost" | "removed";

export interface AttachedCheckInput {
  share: SharedConsoleState;
  participant: ParticipantState;
  /** The participant's *current* effective permissions, freshly resolved. */
  permissions: readonly string[];
}

/**
 * Should this already-attached participant stay attached?
 *
 * Run on a sweep for everyone on every live share. The reason this exists at
 * all is that a permission check at join time is a statement about the past:
 * a person whose role is narrowed, whose break-glass elevation lapses, or who
 * is removed from the org entirely while sitting on a shared production shell
 * would otherwise keep the shell until they chose to close it.
 *
 * The owner is not exempt. Their own socket is the origin of the pty and
 * tearing it down ends the session for everybody, which is the correct
 * outcome: if the person whose credentials the session runs on may no longer
 * execute against the org's resources, the session should not continue.
 */
export function evaluateAttached(
  input: AttachedCheckInput,
): { keep: true } | { keep: false; reason: DetachReason; message: string } {
  const { share, participant, permissions } = input;
  if (share.status === "revoked") {
    return {
      keep: false,
      reason: "share-revoked",
      message: "The sharer revoked this console.",
    };
  }
  if (share.status === "ended") {
    return { keep: false, reason: "share-ended", message: "The session ended." };
  }
  if (participant.status === "removed") {
    return {
      keep: false,
      reason: "removed",
      message: "You were removed from this shared console.",
    };
  }
  if (!grants(permissions, CONSOLE_PERMISSION)) {
    return {
      keep: false,
      reason: "permission-lost",
      message: `Your ${CONSOLE_PERMISSION} permission was withdrawn, so this session was closed.`,
    };
  }
  return { keep: true };
}

/**
 * The pty's geometry, given who is driving.
 *
 * A pty has exactly one window size and several people are looking at it, so
 * somebody's terminal has to be the one that counts. It is the driver's: they
 * are the person whose `vim` has to lay out correctly, and a size chosen by
 * someone who cannot type into it is a size nobody asked for. Everyone else
 * renders that geometry at whatever scale fits their own window — letterboxed,
 * with bars, rather than reflowed.
 *
 * The alternative, resizing to the smallest attached viewport, sounds
 * considerate and is not: it lets any observer shrink the operator's terminal
 * by making their own browser window small, mid-incident, and it means the
 * geometry changes every time somebody joins.
 *
 * Falls back to the last agreed size when the driver has not reported a
 * viewport yet, and to 80x24 when nothing is known — never to zero, which is
 * what a hidden or unmounted terminal reports and what would otherwise reach
 * `setWindow` as a degenerate pty.
 */
export function resolvePtySize(
  driverViewport: { cols: number | null; rows: number | null } | null,
  current: { cols: number; rows: number },
): { cols: number; rows: number } {
  const cols = clampDimension(driverViewport?.cols, current.cols, 80);
  const rows = clampDimension(driverViewport?.rows, current.rows, 24);
  return { cols, rows };
}

/** Terminal dimensions are small positive integers; anything else is noise. */
const MAX_DIMENSION = 1000;

function clampDimension(
  candidate: number | null | undefined,
  fallback: number,
  ultimate: number,
): number {
  const from =
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 1
      ? Math.trunc(candidate)
      : Number.isFinite(fallback) && fallback >= 1
        ? Math.trunc(fallback)
        : ultimate;
  return Math.min(MAX_DIMENSION, Math.max(1, from));
}
