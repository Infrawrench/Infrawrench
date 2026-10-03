/**
 * Per-session SSH host-key pinning for coding-agent VMs.
 *
 * Every agent SSH/SFTP connection carries the user's Claude/Codex logins, a
 * repo tarball or a git bundle, so it must reach the VM the session created.
 * The policy itself (trust the first key while the session is fresh, refuse
 * any other key after) is `decideAgentHostKey` in ssh-tunnel-core, shared
 * with the cloud pipeline; this module persists the pin on the session row
 * (`agent_sessions.host_key_fingerprint`) and mirrors it into the host:port
 * store so the agent terminal and SFTP to the same VM don't prompt again.
 *
 * Which policy applies is decided here, from the session id the agent IPC
 * channels carry; the renderer can no longer ask for verification to be
 * skipped.
 */
import {
  decideAgentHostKey,
  agentHostKeyMismatchMessage,
  sha256Fingerprint,
} from "@infrawrench/ssh-tunnel-core";
import { getDb } from "./main-utils";
import { promptHostKeyDecision } from "./ssh-host-key-prompt";
import {
  HostKeyMismatchError,
  lookupHostKeyPin,
  pinHostKey,
  type HostKeyCheck,
} from "./ssh-host-keys";

export class AgentHostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHostKeyError";
  }
}

type AgentSessionPinRow = {
  id: string;
  created_at: string;
  host_key_fingerprint: string | null;
};

/** sql.js `datetime('now')` is UTC without a zone marker ("YYYY-MM-DD HH:MM:SS"). */
export function parseSqliteUtc(value: string): Date {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
    return new Date(`${trimmed.replace(" ", "T")}Z`);
  }
  return new Date(trimmed);
}

async function loadSessionPin(sessionId: string): Promise<AgentSessionPinRow | null> {
  const db = await getDb();
  const rows = await db.select<AgentSessionPinRow[]>(
    `SELECT id, created_at, host_key_fingerprint FROM agent_sessions WHERE id = ?`,
    [sessionId],
  );
  return rows[0] ?? null;
}

async function recordSessionPin(sessionId: string, fingerprint: string): Promise<void> {
  const db = await getDb();
  // Only ever fills an empty pin: a recorded pin is never overwritten.
  await db.execute(
    `UPDATE agent_sessions SET host_key_fingerprint = ?
     WHERE id = ? AND (host_key_fingerprint IS NULL OR host_key_fingerprint = '')`,
    [fingerprint, sessionId],
  );
}

// The setup pipeline opens several connections at once; serialize the
// decision per session so two first connections can't both "trust first use"
// with different keys, or both prompt.
const sessionQueues = new Map<string, Promise<unknown>>();

function serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.catch(() => undefined);
  sessionQueues.set(sessionId, settled);
  void settled.then(() => {
    if (sessionQueues.get(sessionId) === settled) sessionQueues.delete(sessionId);
  });
  return next;
}

/** Verify the key an agent VM presents against its session's pin. */
export async function verifyAgentHostKey(
  sessionId: string,
  host: string,
  port: number,
  hostKey: Buffer,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const presented = sha256Fingerprint(hostKey);
  return serialized(sessionId, async () => {
    const row = await loadSessionPin(sessionId);
    if (!row) {
      return {
        ok: false,
        error: new AgentHostKeyError(
          `Refusing to connect to ${host}:${port}: agent session ${sessionId} was not found.`,
        ),
      };
    }
    const decision = decideAgentHostKey({
      pinnedFingerprint: row.host_key_fingerprint,
      presentedFingerprint: presented,
      sessionCreatedAt: parseSqliteUtc(row.created_at),
    });
    switch (decision) {
      case "match":
        await pinHostKey(host, port, presented).catch(warnPinFailure);
        return { ok: true };
      case "mismatch":
        return {
          ok: false,
          error: new AgentHostKeyError(
            agentHostKeyMismatchMessage(host, port, row.host_key_fingerprint ?? "", presented),
          ),
        };
      case "trust-first-use":
        await recordSessionPin(sessionId, presented);
        await pinHostKey(host, port, presented).catch(warnPinFailure);
        return { ok: true };
      case "unpinned": {
        // A session created before pinning existed. A key the user already
        // trusts for this address is adopted silently; anything else goes
        // through the normal host-key prompt.
        const known = await lookupHostKeyPin(host, port);
        if (known !== presented) {
          const accepted = await promptHostKeyDecision({
            host,
            port,
            kind: known === undefined ? "first-connect" : "mismatch",
            presentedFingerprint: presented,
            ...(known !== undefined ? { storedFingerprint: known } : {}),
          });
          if (!accepted) {
            return {
              ok: false,
              error: new HostKeyMismatchError(host, port, known ?? "(none)", presented),
            };
          }
          await pinHostKey(host, port, presented).catch(warnPinFailure);
        }
        await recordSessionPin(sessionId, presented);
        return { ok: true };
      }
    }
  });
}

function warnPinFailure(error: unknown): void {
  console.warn("[agent-ssh] failed to mirror the agent VM host key into ssh_host_keys:", error);
}

/** A `HostKeyCheck` bound to one agent session, for the SSH/SFTP helpers. */
export function agentHostKeyCheck(sessionId: string): HostKeyCheck {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("Agent SSH connections need the agent session id");
  }
  return (host, port, hostKey) => verifyAgentHostKey(sessionId, host, port, hostKey);
}
