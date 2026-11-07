import type { DraggableResource } from "./pins";
import { getPlugin } from "../plugins/loader";

/**
 * The plugin to preselect in the SSH tunnel modal when `source` is dropped on an
 * SSH host, or null when its plugin declares no tunnel and the drop deploys its
 * environment instead. A dragged account carries its plugin in `fields`.
 */
export async function sshTunnelServiceForDrop(source: DraggableResource): Promise<string | null> {
  const pluginId =
    source.pluginId === "__account__" ? String(source.fields["pluginId"] ?? "") : source.pluginId;
  const loaded = await getPlugin(pluginId).catch(() => undefined);
  return loaded?.plugin.manifest.sshTunnel ? pluginId : null;
}
