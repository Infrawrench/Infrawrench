/**
 * Sudo-mode ("step-up") re-authentication for account-takeover-adjacent
 * operations.
 *
 * A session cookie proves the user signed in at some point in the last ~13
 * months. That is a fine bar for reading a dashboard and much too low a bar
 * for minting a password-reset link, moving the account's email address, or
 * removing an MFA factor — each of which converts a borrowed session into
 * permanent control of the account.
 *
 * WorkOS records when each session was established, so "prove it's still you"
 * reduces to "your current sign-in must be recent". Callers that fail the check
 * get a 403 carrying `code: "reauthentication_required"`, which the client uses
 * to send the user back through sign-in and retry.
 */
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { workos } from "./workos";
import type { AuthSession } from "../api/auth-middleware";

/**
 * How recently the caller must have authenticated. Long enough to complete a
 * multi-step settings change without re-signing in mid-flow, short enough that
 * a session lifted from a closed laptop is already stale.
 */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

/** Machine-readable marker on the 403 body; clients branch on this, not prose. */
export const REAUTHENTICATION_REQUIRED = "reauthentication_required";

function deny(message: string): never {
  throw new HTTPException(403, {
    res: Response.json({ error: message, code: REAUTHENTICATION_REQUIRED }, { status: 403 }),
  });
}

/**
 * Throws 403 unless the caller's current session was established within
 * {@link STEP_UP_MAX_AGE_MS}. Must run after `sessionMiddleware`.
 *
 * Fails closed: a token with no `sid` claim, a session WorkOS no longer lists,
 * or a WorkOS outage all deny rather than fall through to allowing the
 * sensitive action.
 */
export async function requireRecentAuthentication(c: Context): Promise<void> {
  const session = c.get("session") as AuthSession;

  // Bearer principals (API keys, MCP OAuth tokens) have no interactive sign-in
  // to be recent — these operations are browser-only by design.
  if (!session.sessionId) {
    deny("This action requires a recent sign-in from a browser session.");
  }

  let established: Date | null = null;
  try {
    const list = await workos.userManagement.listSessions(session.userId);
    const current = list.data.find((s) => s.id === session.sessionId);
    if (current) established = new Date(current.createdAt);
  } catch (err) {
    console.error(`[step-up] listSessions failed for ${session.userId}:`, err);
    deny("Couldn't confirm how recently you signed in. Please sign in again.");
  }

  if (!established || Number.isNaN(established.getTime())) {
    deny("Couldn't confirm how recently you signed in. Please sign in again.");
  }

  if (Date.now() - established.getTime() > STEP_UP_MAX_AGE_MS) {
    deny("For your security, please sign in again to confirm this change.");
  }
}
