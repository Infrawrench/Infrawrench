/**
 * Per-session SSH host-key pinning for cloud coding-agent VMs.
 *
 * The setup pipeline sends a short-lived GitHub clone token, the session's
 * env values and attached-service enrollment keys over these connections,
 * so each one must reach the VM the session created. The policy is
 * `decideAgentHostKey` in ssh-tunnel-core, shared with the desktop app: the
 * first key seen while the session is fresh is pinned on the session row
 * (`agent_sessions.host_key_fingerprint`), and any other key is refused
 * after that. The pin is also mirrored into the org's `ssh_host_keys` so the
 * browser terminal to the same VM doesn't ask the user to trust it again.
 *
 * A session created before pinning existed has no pin and no prompt to fall
 * back on here, so it is adopted only when the org already trusts the
 * presented key for that address (e.g. after opening the VM's terminal once).
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  agentHostKeyMismatchMessage,
  decideAgentHostKey,
  sha256Fingerprint,
} from "@infrawrench/ssh-tunnel-core";
import { db } from "../db/client";
import { agentSessions } from "../db/schema";
import { lookupHostKeyPin, trustHostKey } from "./ssh-host-keys";

export class AgentHostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHostKeyError";
  }
}

export async function verifyAgentHostKey(
  sessionId: string,
  organizationId: string,
  host: string,
  port: number,
  hostKey: Buffer,
): Promise<void> {
  const presented = sha256Fingerprint(hostKey);
  const [row] = await db
    .select({
      createdAt: agentSessions.createdAt,
      hostKeyFingerprint: agentSessions.hostKeyFingerprint,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.organizationId, organizationId)))
    .limit(1);
  if (!row) {
    throw new AgentHostKeyError(
      `Refusing to connect to ${host}:${port}: agent session ${sessionId} was not found.`,
    );
  }
  const decision = decideAgentHostKey({
    pinnedFingerprint: row.hostKeyFingerprint,
    presentedFingerprint: presented,
    sessionCreatedAt: row.createdAt,
  });
  switch (decision) {
    case "match":
      await mirrorOrgPin(organizationId, host, port, presented);
      return;
    case "mismatch":
      throw new AgentHostKeyError(
        agentHostKeyMismatchMessage(host, port, row.hostKeyFingerprint ?? "", presented),
      );
    case "trust-first-use":
      await recordSessionPin(sessionId, host, port, presented);
      await mirrorOrgPin(organizationId, host, port, presented);
      return;
    case "unpinned": {
      const known = await lookupHostKeyPin(organizationId, host, port);
      if (known !== presented) {
        throw new AgentHostKeyError(
          `The agent VM at ${host}:${port} has no pinned SSH host key (this session predates ` +
            `host-key pinning) and its key (${presented}) is not one this organization trusts. ` +
            `Open the VM's terminal once and confirm its host key, then retry.`,
        );
      }
      await recordSessionPin(sessionId, host, port, presented);
      return;
    }
  }
}

/** Fill the session's empty pin; a racing connection that pinned first wins. */
async function recordSessionPin(
  sessionId: string,
  host: string,
  port: number,
  presented: string,
): Promise<void> {
  const updated = await db
    .update(agentSessions)
    .set({ hostKeyFingerprint: presented })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.hostKeyFingerprint)))
    .returning({ id: agentSessions.id });
  if (updated.length > 0) return;
  const [row] = await db
    .select({ hostKeyFingerprint: agentSessions.hostKeyFingerprint })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  const pinned = row?.hostKeyFingerprint;
  if (pinned && pinned !== presented) {
    throw new AgentHostKeyError(agentHostKeyMismatchMessage(host, port, pinned, presented));
  }
}

async function mirrorOrgPin(
  organizationId: string,
  host: string,
  port: number,
  fingerprint: string,
): Promise<void> {
  try {
    await trustHostKey(organizationId, host, port, fingerprint);
  } catch (error) {
    console.warn(`[agent-setup] could not mirror the agent VM host key for ${host}:${port}`, error);
  }
}

/**
 * ssh2 `hostVerifier` for one agent session. A refusal is stored on
 * `errorRef` so the caller can surface it instead of ssh2's generic error.
 */
export function makeAgentHostVerifier(
  sessionId: string,
  organizationId: string,
  host: string,
  port: number,
  errorRef: { value: Error | null },
): (hostKey: Buffer, verify: (valid: boolean) => void) => void {
  return (hostKey, verify) => {
    verifyAgentHostKey(sessionId, organizationId, host, port, hostKey).then(
      () => verify(true),
      (error: unknown) => {
        errorRef.value = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[agent-setup] host key refused for ${host}:${port}: ${errorRef.value.message}`,
        );
        verify(false);
      },
    );
  };
}
