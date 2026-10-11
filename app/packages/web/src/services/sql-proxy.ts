/**
 * Server-side SQL query proxy.
 * Executes queries against user databases via plugin client's executeQuery method.
 */
import type { WebSocket } from "ws";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decryptAccountCredentials } from "@infrawrench/server-core/provider-oauth";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";
import { withEgressScope } from "@infrawrench/server-core/egress-guard";

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

    const loaded = await getPlugin(account.pluginId);
    if (!loaded) {
      ws.send(JSON.stringify({ type: "sql:error", error: "Plugin not found" }));
      return;
    }
    // Refreshes an expiring OAuth access token before the client is built.
    const credentials = await decryptAccountCredentials(account, loaded.plugin.manifest);

    const hostServices = await buildPluginHostServices(loaded.plugin.manifest, credentials, {
      accountId: account.id,
      organizationId,
    });
    const client = withEgressScope(loaded.plugin.createClient(credentials, hostServices), {
      accountId: account.id,
      organizationId,
    });

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
