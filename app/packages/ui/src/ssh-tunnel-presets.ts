import type { PluginManifest } from "@infrawrench/plugin-base";

/**
 * The service choices in the "Connect to service via SSH" modal, in both desktop
 * and web. Each plugin declares its own with `manifest.sshTunnel`; only the
 * "Custom..." entry belongs to the host.
 */
export interface SshTunnelPreset {
  /** The plugin id, or {@link CUSTOM_SSH_TUNNEL_PRESET}'s own key. */
  key: string;
  label: string;
  /** The plugin the tunneled account is created with; null for "Custom...". */
  pluginId: string | null;
  /** Default remote port to forward; 0 for "Custom...", which asks for one. */
  port: number;
  /** What the tunneled account stores, with `{port}` for the local end. */
  credentials?: Readonly<Record<string, string>>;
}

/** The fields of a plugin the presets read, from a manifest or `GET /plugins`. */
export interface SshTunnelPlugin {
  id: string;
  sshTunnel?: PluginManifest["sshTunnel"];
}

export const CUSTOM_SSH_TUNNEL_PRESET: SshTunnelPreset = {
  key: "custom",
  label: "Custom…",
  pluginId: null,
  port: 0,
};

/**
 * Every plugin that declares a tunnel, then "Custom...". Ordered by port rather
 * than by the list it came from, because desktop and web list their plugins in
 * different orders and the two modals should agree.
 */
export function sshTunnelPresets(plugins: readonly SshTunnelPlugin[]): SshTunnelPreset[] {
  const declared = plugins.flatMap(({ id, sshTunnel }) =>
    sshTunnel
      ? [
          {
            key: id,
            label: sshTunnel.label,
            pluginId: id,
            port: sshTunnel.defaultPort,
            credentials: sshTunnel.credentials,
          },
        ]
      : [],
  );
  declared.sort((a, b) => a.port - b.port || a.label.localeCompare(b.label));
  return [...declared, CUSTOM_SSH_TUNNEL_PRESET];
}

/**
 * Build the credentials object stored on a newly-created tunneled account.
 * `{port}` is the remote port, because the SSH tunnel forwards the remote
 * service to the same port on the local host.
 */
export function buildSshTunnelCredentials(
  preset: SshTunnelPreset,
  remotePort: number,
): Record<string, string> {
  if (!preset.credentials) return { host: `localhost:${remotePort}` };
  return Object.fromEntries(
    Object.entries(preset.credentials).map(([key, value]) => [
      key,
      value.replaceAll("{port}", String(remotePort)),
    ]),
  );
}
