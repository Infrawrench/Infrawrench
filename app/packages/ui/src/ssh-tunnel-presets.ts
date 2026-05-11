/**
 * Service presets used by the "Connect to service via SSH" tunnel modal in
 * both desktop and web. Each preset maps a target service (Docker, Postgres,
 * etc.) to the plugin that will be created and the default remote port to
 * forward.
 */
export const SSH_TUNNEL_PRESETS = {
  docker: { label: "Docker", pluginId: "docker", port: 2375 },
  postgres: { label: "PostgreSQL", pluginId: "postgres", port: 5432 },
  mysql: { label: "MySQL", pluginId: "mysql", port: 3306 },
  redis: { label: "Redis", pluginId: "redis", port: 6379 },
  memcached: { label: "Memcached", pluginId: "memcached", port: 11211 },
  custom: { label: "Custom...", pluginId: null, port: 0 },
} as const;

export type SshTunnelPresetKey = keyof typeof SSH_TUNNEL_PRESETS;

/**
 * Build the credentials object stored on a newly-created tunneled account.
 * The remote port is rewritten to `localhost:<port>` because the SSH tunnel
 * forwards the remote service to the local host.
 */
export function buildSshTunnelCredentials(
  pluginId: string,
  remotePort: number,
): Record<string, string> {
  switch (pluginId) {
    case "docker":
      return { dockerHost: `tcp://localhost:${remotePort}` };
    case "postgres":
      return { connectionString: `postgresql://localhost:${remotePort}/postgres` };
    case "mysql":
      return { connectionString: `mysql://localhost:${remotePort}/mysql` };
    case "redis":
      return { connectionString: `redis://localhost:${remotePort}` };
    case "memcached":
      return { connectionString: `memcached://localhost:${remotePort}` };
    default:
      return { host: `localhost:${remotePort}` };
  }
}
