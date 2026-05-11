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

interface DirectSshParams {
  sshKeyId: string;
  host: string;
  username: string;
}

export async function handleSshSession(
  ws: WebSocket,
  organizationId: string,
  accountId: string,
  resourceId?: string,
  directSsh?: DirectSshParams,
  cols?: number,
  rows?: number,
): Promise<void> {
  try {
    let sshConfig: { host: string; port: number; username: string; privateKey: string };

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
      sshConfig = {
        host: directSsh.host,
        port: 22,
        username: directSsh.username,
        privateKey,
      };
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

      const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
      const client = loaded.plugin.createClient(credentials, hostServices);
      const pluginSshConfig = client.getSshConfig?.();
      if (!pluginSshConfig) {
        ws.send(JSON.stringify({ type: "ssh:error", error: "Plugin does not support SSH" }));
        return;
      }
      sshConfig = pluginSshConfig;
    }

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
          conn.end();
        });
      });
    });

    conn.on("error", (err) => {
      ws.send(JSON.stringify({ type: "ssh:error", error: err.message }));
    });

    conn.connect({
      host: sshConfig.host,
      port: sshConfig.port ?? 22,
      username: sshConfig.username,
      privateKey: sshConfig.privateKey,
    });
  } catch (e) {
    ws.send(
      JSON.stringify({
        type: "ssh:error",
        error: e instanceof Error ? e.message : "Unknown SSH error",
      }),
    );
  }
}
