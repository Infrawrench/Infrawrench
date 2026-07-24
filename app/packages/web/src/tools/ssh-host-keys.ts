/**
 * SSH host-key trust tools — expose the org's host-key pin store to MCP
 * clients and the chat agent. When ssh_exec (or SFTP/tunnels) hits an
 * untrusted host it fails with the presented fingerprint; these tools let the
 * model surface that fingerprint to the user and, once confirmed, record the
 * trust decision and retry.
 *
 * trust/remove are destructive-tier: pinning a host key is a security
 * decision (a wrong "yes" accepts a man-in-the-middle), so chat always routes
 * it through the human approval flow. Same `accounts:read` / `accounts:write`
 * permissions as the HTTP API.
 */
import { z } from "zod";
import { eq, and, asc } from "drizzle-orm";
import { db } from "../db/client";
import { sshHostKeys } from "../db/schema";
import { trustHostKey, HostKeyMismatchError } from "../services/ssh-host-keys";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

const FINGERPRINT_REGEX = /^SHA256:[A-Za-z0-9+/]+$/;

export function sshHostKeyTools(): ToolDefinition[] {
  return [
    {
      name: "list_trusted_ssh_hosts",
      title: "List trusted SSH hosts",
      description:
        "List the SSH host-key fingerprints pinned for this organization (host, port, " +
        "SHA256 fingerprint). Connections to hosts not in this list fail until the host is " +
        "trusted with trust_ssh_host.",
      inputSchema: {},
      risk: "read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "accounts:read");
        if (denied) return denied;
        const rows = await db
          .select({
            id: sshHostKeys.id,
            host: sshHostKeys.host,
            port: sshHostKeys.port,
            fingerprint: sshHostKeys.fingerprint,
            createdAt: sshHostKeys.createdAt,
          })
          .from(sshHostKeys)
          .where(eq(sshHostKeys.organizationId, auth.organizationId))
          .orderBy(asc(sshHostKeys.host));
        return ok(rows);
      },
    },

    {
      name: "trust_ssh_host",
      title: "Trust SSH host",
      description:
        "Pin an SSH host's key fingerprint so SSH/SFTP/tunnel connections to it are allowed. " +
        "Use after ssh_exec fails with 'has not been trusted yet' or 'host key changed' — those " +
        "errors include the presented SHA256 fingerprint. SECURITY: only trust a fingerprint the " +
        "user has confirmed out-of-band (e.g. against the provider console or `ssh-keygen -lf`); " +
        "accepting an unverified fingerprint would let a man-in-the-middle intercept the " +
        "connection. When replacing a changed key, pass previousFingerprint for the audit trail.",
      inputSchema: {
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535).default(22),
        fingerprint: z
          .string()
          .describe("The presented host key fingerprint, 'SHA256:<base64>' (no padding)"),
        previousFingerprint: z
          .string()
          .optional()
          .describe("When replacing a changed key: the previously-stored fingerprint"),
      },
      risk: "destructive",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "accounts:write");
        if (denied) return denied;
        const host = String(input["host"] ?? "").trim();
        const port = Number(input["port"] ?? 22);
        const fingerprint = String(input["fingerprint"] ?? "").trim();
        const previousFingerprint = input["previousFingerprint"] as string | undefined;
        if (!host) return err("host is required");
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return err("port must be an integer between 1 and 65535");
        }
        if (!FINGERPRINT_REGEX.test(fingerprint)) {
          return err("fingerprint must be 'SHA256:<base64>' (no padding)");
        }

        try {
          await trustHostKey(auth.organizationId, host, port, fingerprint);
        } catch (e) {
          // A concurrent connect observed a different fingerprint than the one
          // the user accepted — surface both so they can re-verify.
          if (e instanceof HostKeyMismatchError) {
            return err(
              `Host key conflict for ${host}:${port} — stored=${e.storedFingerprint}, ` +
                `presented=${e.presentedFingerprint}. Re-verify with the user before retrying.`,
            );
          }
          throw e;
        }

        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          action: previousFingerprint ? "ssh_host_key.replaced" : "ssh_host_key.trusted",
          entityType: "ssh_host_key",
          entityId: `${host}:${port}`,
          metadata: {
            host,
            port,
            fingerprint,
            ...(previousFingerprint ? { previousFingerprint } : {}),
            source: auth.source,
            tool: "trust_ssh_host",
          },
        });

        return ok({
          trusted: true,
          host,
          port,
          fingerprint,
          note: "Retry the original SSH/SFTP/tunnel action now.",
        });
      },
    },

    {
      name: "remove_ssh_host_trust",
      title: "Remove SSH host trust",
      description:
        "Remove a pinned SSH host-key fingerprint. The next connection to that host will fail " +
        "until it is trusted again — use to revoke trust in a decommissioned or compromised host.",
      inputSchema: {
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535).default(22),
      },
      risk: "destructive",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "accounts:write");
        if (denied) return denied;
        const host = String(input["host"] ?? "").trim();
        const port = Number(input["port"] ?? 22);
        if (!host) return err("host is required");

        const deleted = await db
          .delete(sshHostKeys)
          .where(
            and(
              eq(sshHostKeys.organizationId, auth.organizationId),
              eq(sshHostKeys.host, host),
              eq(sshHostKeys.port, port),
            ),
          )
          .returning({ fingerprint: sshHostKeys.fingerprint });
        if (deleted.length === 0) {
          return err(`No pinned host key for ${host}:${port} (see list_trusted_ssh_hosts)`);
        }

        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          action: "ssh_host_key.removed",
          entityType: "ssh_host_key",
          entityId: `${host}:${port}`,
          metadata: {
            host,
            port,
            fingerprint: deleted[0]!.fingerprint,
            source: auth.source,
            tool: "remove_ssh_host_trust",
          },
        });

        return ok({ removed: true, host, port, fingerprint: deleted[0]!.fingerprint });
      },
    },
  ];
}
