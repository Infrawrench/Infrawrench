/**
 * Server-side SQL query proxy.
 * Executes queries against user databases via plugin client's executeQuery method.
 */
import type { WebSocket } from "ws";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";

export async function handleSqlSession(
  ws: WebSocket,
  organizationId: string,
  accountId: string,
  sql: string,
): Promise<void> {
  try {
    const [account] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));

    if (!account) {
      ws.send(JSON.stringify({ type: "sql:error", error: "Account not found" }));
      return;
    }

    const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
    const credentials = JSON.parse(plaintext) as Record<string, string>;

    const loaded = await getPlugin(account.pluginId);
    if (!loaded) {
      ws.send(JSON.stringify({ type: "sql:error", error: "Plugin not found" }));
      return;
    }

    const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
    const client = loaded.plugin.createClient(credentials, hostServices);

    // Use REST-based executeQuery if available
    if (client.executeQuery) {
      const result = await client.executeQuery(accountId, accountId, sql);
      ws.send(
        JSON.stringify({
          type: "sql:result",
          rows: result.rows,
          durationMs: result.durationMs,
        }),
      );
    } else {
      ws.send(
        JSON.stringify({ type: "sql:error", error: "Plugin does not support query execution" }),
      );
    }
  } catch (e) {
    ws.send(
      JSON.stringify({
        type: "sql:error",
        error: e instanceof Error ? e.message : "Unknown SQL error",
      }),
    );
  }
}
