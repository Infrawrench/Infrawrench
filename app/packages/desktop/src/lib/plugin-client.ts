import { invoke } from "./invoke";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./sql-drivers";
import type { PluginClient } from "@infrawrench/plugin-base";

export async function createPluginClient(
  accountId: string,
  pluginId: string,
): Promise<PluginClient> {
  const db = await getDb();
  const rows = await db.select<{ encrypted_credentials: string; credentials_iv: string }[]>(
    "SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = $1",
    [accountId],
  );
  if (!rows[0]) throw new Error("Account not found");
  const plaintext = await invoke<string>("decrypt_value", {
    ciphertext: rows[0].encrypted_credentials,
    iv: rows[0].credentials_iv,
  });
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  const loaded = await getPlugin(pluginId);
  if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
  const { plugin } = loaded;
  const services = buildPluginHostServices(plugin.manifest, credentials);
  return plugin.createClient(credentials, services);
}
