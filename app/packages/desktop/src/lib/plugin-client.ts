import { invoke } from "./invoke";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./sql-drivers";
import type { PluginClient } from "@infrawrench/plugin-base";

export async function createPluginClient(
  accountId: string,
  pluginId: string,
): Promise<PluginClient> {
  const credentials = await invoke<Record<string, string>>("account_get_credentials", {
    accountId,
  });
  const loaded = await getPlugin(pluginId);
  if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
  const { plugin } = loaded;
  const services = buildPluginHostServices(plugin.manifest, credentials);
  return plugin.createClient(credentials, services);
}
