/**
 * Host-key policy for coding-agent VMs, shared by the desktop main process
 * and the cloud's agent setup pipeline.
 *
 * Agent VMs carry the user's Claude/Codex logins, a repo tarball and
 * short-lived clone tokens, so every connection must reach the VM the
 * session created. The key is pinned per agent session (not per host:port,
 * so a VM that changes address keeps its pin and a reassigned address never
 * inherits one):
 *
 * - The first key seen while the session is still inside its creation
 *   window is trusted without asking. That connection happens automatically
 *   while the fresh VM boots, and it is what trust-on-first-use means here.
 * - After a pin exists, any other key is refused outright. There is no
 *   "accept anyway": a rebuilt VM means a new session.
 * - A session with no pin outside the window (one created before pinning
 *   existed) is the caller's call: the desktop asks the user, the cloud
 *   requires a host key the org already trusts.
 */

/**
 * How long after a session is created its first presented host key is
 * trusted without a prompt. Covers waiting for the VM to report running
 * (up to 15 minutes) plus the SSH retry loop that follows (another 15).
 */
export const AGENT_HOST_KEY_TOFU_WINDOW_MS = 60 * 60 * 1000;

export type AgentHostKeyDecision =
  /** The presented key is the pinned one. */
  | "match"
  /** A different key than the pinned one: refuse. */
  | "mismatch"
  /** No pin yet and the session is fresh: trust and pin the presented key. */
  | "trust-first-use"
  /** No pin and the session is past its creation window. */
  | "unpinned";

export function decideAgentHostKey(input: {
  pinnedFingerprint: string | null | undefined;
  presentedFingerprint: string;
  /** When the agent session (and so its VM) was created. */
  sessionCreatedAt: Date;
  now?: Date;
}): AgentHostKeyDecision {
  const pinned = input.pinnedFingerprint?.trim();
  if (pinned) return pinned === input.presentedFingerprint ? "match" : "mismatch";
  const created = input.sessionCreatedAt.getTime();
  const now = (input.now ?? new Date()).getTime();
  // An unparseable timestamp is never fresh.
  if (!Number.isFinite(created)) return "unpinned";
  const age = now - created;
  return age >= 0 && age <= AGENT_HOST_KEY_TOFU_WINDOW_MS ? "trust-first-use" : "unpinned";
}

/**
 * Message for a refused agent VM connection. Avoids the words the setup
 * pipelines' retry matcher treats as transient (timeout, handshake, ...), so
 * a refused key fails the session instead of being retried for 15 minutes.
 */
export function agentHostKeyMismatchMessage(
  host: string,
  port: number,
  pinnedFingerprint: string,
  presentedFingerprint: string,
): string {
  return (
    `The agent VM at ${host}:${port} presented a different SSH host key than the one ` +
    `pinned when this session was created (pinned ${pinnedFingerprint}, presented ` +
    `${presentedFingerprint}). Refusing to connect: the address may now belong to a ` +
    `different machine, or someone may be intercepting the connection. If you rebuilt ` +
    `the VM yourself, delete this agent session and start a new one.`
  );
}
