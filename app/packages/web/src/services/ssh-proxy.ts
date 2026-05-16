/**
 * Server-side SSH terminal proxy.
 * Connects to user infrastructure via ssh2, streams I/O over WebSocket.
 */
import { Client } from "ssh2";
import type { WebSocket } from "ws";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, sshKeys } from "@/db/schema";
import { decrypt, buildAad } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";
import { buildInProcessAgent, type AgentAuditContext } from "@/services/ssh-agent";
import { logAudit } from "@/services/audit";
import { forwardOutHop, resolveSshChain, type SshHop } from "@infrawrench/plugin-ssh";

interface DirectSshParams {
  sshKeyId: string;
  host: string;
  username: string;
  /** Optional jumpbox SSH account id to route this direct connection through. */
  connectThroughAccountId?: string;
}

/**
 * Load an SSH account's credentials and return them shaped for the chain
 * resolver. Throws if the account is missing or not an SSH plugin account.
 */
async function loadSshAccountForChain(
  accountIdToLoad: string,
  organizationId: string,
): Promise<{
  host: string;
  port: number;
  username: string;
  privateKey: string;
  connectThroughAccountId?: string;
}> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountIdToLoad), eq(accounts.organizationId, organizationId)));

  if (!account) {
    throw new Error(`SSH jumpbox account ${accountIdToLoad} not found`);
  }
  if (account.pluginId !== "ssh") {
    throw new Error(
      `SSH jumpbox chain hop ${accountIdToLoad} is not an SSH account (plugin=${account.pluginId})`,
    );
  }

  const plaintext = await decrypt(
    account.encryptedCredentials,
    account.credentialsIv,
    buildAad("account", account.id, "credentials"),
  );
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  const through = credentials.connectThroughAccountId;
  return {
    host: credentials.host ?? "",
    port: Number(credentials.port ?? 22) || 22,
    username: credentials.username ?? "root",
    privateKey: credentials.privateKey ?? "",
    ...(through ? { connectThroughAccountId: through } : {}),
  };
}

export async function handleSshSession(
  ws: WebSocket,
  organizationId: string,
  accountId: string,
  resourceId?: string,
  directSsh?: DirectSshParams,
  cols?: number,
  rows?: number,
  agentForward?: boolean,
  userId?: string,
): Promise<void> {
  try {
    let targetConfig: { host: string; port: number; username: string; privateKey: string };
    let connectThroughAccountId: string | undefined;

    if (directSsh) {
      // Direct SSH via SSH key — used for sshHost resources (EC2, droplets, etc.)
      const [key] = await db
        .select()
        .from(sshKeys)
        .where(and(eq(sshKeys.id, directSsh.sshKeyId), eq(sshKeys.organizationId, organizationId)));

      if (!key || !key.encryptedPrivateKey || !key.privateKeyIv) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "SSH key not found" }));
        return;
      }

      const privateKey = await decrypt(
        key.encryptedPrivateKey,
        key.privateKeyIv,
        buildAad("sshKey", key.id, "privateKey"),
      );
      targetConfig = {
        host: directSsh.host,
        port: 22,
        username: directSsh.username,
        privateKey,
      };
      connectThroughAccountId = directSsh.connectThroughAccountId;
    } else {
      // Plugin-provided SSH config
      const [account] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));

      if (!account) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "Account not found" }));
        return;
      }

      const plaintext = await decrypt(
        account.encryptedCredentials,
        account.credentialsIv,
        buildAad("account", account.id, "credentials"),
      );
      const credentials = JSON.parse(plaintext) as Record<string, string>;

      const loaded = await getPlugin(account.pluginId);
      if (!loaded) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "Plugin not found" }));
        return;
      }

      const hostServices = await buildPluginHostServices(loaded.plugin.manifest, credentials, {
        accountId: account.id,
      });
      const client = loaded.plugin.createClient(credentials, hostServices);
      const pluginSshConfig = client.getSshConfig?.();
      if (!pluginSshConfig) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "Plugin does not support SSH" }));
        return;
      }
      targetConfig = pluginSshConfig;
      // Only SSH plugin accounts can declare a jump chain.
      if (account.pluginId === "ssh") {
        connectThroughAccountId = credentials.connectThroughAccountId || undefined;
      }
    }

    // Resolve the full hop list. When there's no jumpbox the chain is a single hop.
    let hops: SshHop[];
    if (connectThroughAccountId) {
      const upstream = await resolveSshChain(connectThroughAccountId, (id) =>
        loadSshAccountForChain(id, organizationId),
      );
      hops = [...upstream, targetConfig];
    } else {
      hops = [targetConfig];
    }

    const finalConfig = hops[hops.length - 1]!;
    const intermediates: Client[] = [];
    const conn = new Client();

    conn.on("ready", () => {
      conn.shell({ term: "xterm-256color", cols: cols ?? 80, rows: rows ?? 24 }, (err, stream) => {
        if (err) {
          ws.send(JSON.stringify({ type: "ssh:error", error: err.message }));
          conn.end();
          return;
        }

        ws.send(JSON.stringify({ type: "ssh:connected" }));

        stream.on("data", (data: Buffer) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "ssh:data", data: data.toString("base64") }));
          }
        });

        stream.stderr.on("data", (data: Buffer) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "ssh:data", data: data.toString("base64") }));
          }
        });

        stream.on("close", () => {
          ws.send(JSON.stringify({ type: "ssh:closed" }));
          conn.end();
        });

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as {
              type: string;
              data?: string;
              cols?: number;
              rows?: number;
            };

            if (msg.type === "ssh:data" && msg.data) {
              stream.write(Buffer.from(msg.data, "base64"));
            } else if (msg.type === "ssh:resize" && msg.cols && msg.rows) {
              stream.setWindow(msg.rows, msg.cols, 0, 0);
            }
          } catch {
            /* ignore malformed messages */
          }
        });

        ws.on("close", () => {
          stream.end();
          for (const c of intermediates) {
            try {
              c.end();
            } catch {
              /* ignore */
            }
          }
          conn.end();
        });
      });
    });

    conn.on("error", (err) => {
      ws.send(JSON.stringify({ type: "ssh:error", error: err.message }));
      for (const c of intermediates) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
    });

    const auditContext: AgentAuditContext | undefined = agentForward
      ? {
          organizationId,
          userId,
          accountId,
          resourceId,
          sshKeyId: directSsh?.sshKeyId ?? "",
          sshHost: finalConfig.host,
          sshUsername: finalConfig.username,
        }
      : undefined;
    const forwardAgent = agentForward
      ? buildInProcessAgent(finalConfig.privateKey, auditContext)
      : null;
    if (agentForward && !forwardAgent) {
      ws.send(
        JSON.stringify({
          type: "ssh:error",
          error: "Agent forwarding requested but the SSH key could not be parsed.",
        }),
      );
      return;
    }
    if (forwardAgent && auditContext) {
      void logAudit({
        organizationId: auditContext.organizationId,
        userId: auditContext.userId,
        action: "ssh.agent.session_opened",
        entityType: "ssh-session",
        entityId: auditContext.accountId,
        metadata: {
          sshKeyId: auditContext.sshKeyId,
          sshHost: auditContext.sshHost,
          sshUsername: auditContext.sshUsername,
          ...(auditContext.resourceId ? { resourceId: auditContext.resourceId } : {}),
          ...(hops.length > 1 ? { hopCount: hops.length } : {}),
        },
      });
    }

    if (hops.length > 1) {
      void logAudit({
        organizationId,
        userId,
        action: "ssh.session.chain_opened",
        entityType: "ssh-session",
        entityId: accountId,
        metadata: {
          hopCount: hops.length,
          hops: hops.map((h, i) => ({
            index: i,
            host: h.host,
            port: h.port,
            username: h.username,
          })),
          ...(resourceId ? { resourceId } : {}),
        },
      });
    }

    // Open each intermediate hop, then dial the final target on `conn`.
    // ssh2's ConnectConfig types `sock` as Node's `Readable`, but the
    // `forwardOut` stream is in fact a full duplex — cast accordingly.
    type SshSock = import("stream").Readable;
    const dialFinal = (sock?: SshSock) => {
      conn.connect({
        ...(sock ? { sock } : { host: finalConfig.host, port: finalConfig.port ?? 22 }),
        username: finalConfig.username,
        privateKey: finalConfig.privateKey,
        ...(forwardAgent ? { agent: forwardAgent, agentForward: true } : {}),
      });
    };

    if (hops.length === 1) {
      dialFinal();
    } else {
      try {
        let prev: Client | null = null;
        for (let i = 0; i < hops.length - 1; i++) {
          const hop = hops[i]!;
          const client = new Client();
          intermediates.push(client);
          const sockForThis = prev
            ? ((await forwardOutHop(prev, hop.host, hop.port)) as SshSock)
            : undefined;
          await new Promise<void>((resolve, reject) => {
            client.once("ready", () => resolve());
            client.once("error", (err) =>
              reject(err instanceof Error ? err : new Error(String(err))),
            );
            client.connect({
              ...(sockForThis ? { sock: sockForThis } : { host: hop.host, port: hop.port ?? 22 }),
              username: hop.username,
              privateKey: hop.privateKey,
            });
          });
          prev = client;
        }
        const finalSock = (await forwardOutHop(
          prev!,
          finalConfig.host,
          finalConfig.port ?? 22,
        )) as SshSock;
        dialFinal(finalSock);
      } catch (err) {
        for (const c of intermediates) {
          try {
            c.end();
          } catch {
            /* ignore */
          }
        }
        ws.send(
          JSON.stringify({
            type: "ssh:error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
    }
  } catch (e) {
    ws.send(
      JSON.stringify({
        type: "ssh:error",
        error: e instanceof Error ? e.message : "Unknown SSH error",
      }),
    );
  }
}
