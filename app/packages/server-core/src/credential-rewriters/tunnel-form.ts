/**
 * Which credential values the SSH-tunnel rewriter rewrites, and how: kept
 * apart from `tunnel-resolver.ts` (which opens tunnels, so the gateway only)
 * so code that must know whether a rewrite happened, such as CI lending,
 * can ask without importing the tunnel itself.
 *
 * Handles common connection string formats:
 *   - tcp://host:port  → tcp://127.0.0.1:{localPort}
 *   - protocol://user:pass@host:port/db → protocol://user:pass@127.0.0.1:{localPort}/db
 *   - host:port → 127.0.0.1:{localPort}
 * Anything else (a kubeconfig's YAML, a token) is left as it is.
 */
export function applyTunnelToConnectionString(connectionString: string, localPort: number): string {
  try {
    const url = new URL(connectionString);
    url.hostname = "127.0.0.1";
    url.port = String(localPort);
    return url.toString();
  } catch {
    // Not a URL: try host:port pattern
    if (/^(.+):(\d+)$/.test(connectionString)) {
      return `127.0.0.1:${localPort}`;
    }
    return connectionString;
  }
}

/** Whether the tunnel rewriter changes this value: a URL or `host:port`. */
export function tunnelRewrites(value: string): boolean {
  return (
    applyTunnelToConnectionString(value, 1) !== value ||
    applyTunnelToConnectionString(value, 2) !== value
  );
}
