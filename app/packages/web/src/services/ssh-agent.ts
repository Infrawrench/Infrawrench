/**
 * Web wrapper over the shared in-process SSH agent in
 * `@infrawrench/ssh-tunnel-core`. The shared core implements the OpenSSH
 * agent wire protocol; this thin module adds an `onSign` hook that pushes an
 * audit log row per sign-request so org operators can see exactly which key
 * the cloud proxy used to authenticate on their behalf.
 *
 * The shared implementation lives in `plugin-architecture/packages/ssh-tunnel-core/src/in-process-agent.ts`
 * and is consumed without the audit hook by `app/packages/desktop/electron/ssh-shell-agent.ts`.
 */
import {
  buildInProcessAgent as buildInProcessAgentCore,
  type InProcessAgent,
  type SignOutcome,
} from "@infrawrench/ssh-tunnel-core";
import { logAudit } from "@/services/audit";

/**
 * Context recorded on every forwarded sign-request so users can see exactly
 * which key the cloud proxy used to authenticate on their behalf. Optional —
 * when omitted, the agent skips audit writes (used by tests / non-cloud paths).
 */
export interface AgentAuditContext {
  organizationId: string;
  userId?: string | undefined;
  accountId: string;
  resourceId?: string | undefined;
  sshKeyId: string;
  sshHost: string;
  sshUsername: string;
}

function makeAuditOnSign(audit: AgentAuditContext): (outcome: SignOutcome) => void {
  return (outcome) => {
    void logAudit({
      organizationId: audit.organizationId,
      userId: audit.userId,
      action: outcome.failureReason ? "ssh.agent.sign_failed" : "ssh.agent.sign",
      entityType: "ssh-session",
      entityId: audit.accountId,
      metadata: {
        sshKeyId: audit.sshKeyId,
        sshHost: audit.sshHost,
        sshUsername: audit.sshUsername,
        ...(audit.resourceId ? { resourceId: audit.resourceId } : {}),
        ...(outcome.keyType ? { keyType: outcome.keyType } : {}),
        ...(outcome.signatureFormat ? { signatureFormat: outcome.signatureFormat } : {}),
        ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
      },
    });
  };
}

/**
 * Parse a PEM private key and return an `InProcessAgent` that signs from
 * memory using the shared core. When `audit` is provided, every sign-request
 * also writes an `ssh.agent.sign[_failed]` audit row.
 */
export function buildInProcessAgent(
  privateKeyPem: string,
  audit?: AgentAuditContext,
): InProcessAgent | null {
  return buildInProcessAgentCore(privateKeyPem, audit ? { onSign: makeAuditOnSign(audit) } : {});
}
