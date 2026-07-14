/**
 * SSRF allowlist for `k8s_api_request` (see k8s-host.ts).
 *
 * The channel proxies plugin HTTP through the main process (Node) so we can
 * supply per-cluster CA certs. That also means a compromised renderer could
 * use it to probe targets the browser sandbox would never let it reach:
 * cloud metadata services (169.254.169.254), the local Docker daemon,
 * internal corporate services, etc. So requests to private/loopback/
 * link-local addresses are refused unless the host:port was registered here
 * first.
 *
 * Trust model: an endpoint is registered only when the MAIN process itself
 * learns it from a kubeconfig in the user's credential store — the encrypted
 * accounts table that only main can decrypt (see the account_* handlers in
 * main.ts). Adding a cluster there is a deliberate user action through the
 * credential UI, so its API endpoints (e.g. a minikube at 127.0.0.1 or a
 * VPN'd cluster at 10.x.x.x) are user-intended. Nothing in this module is
 * reachable from a renderer-supplied URL: there is deliberately no IPC that
 * registers an endpoint directly.
 */
import net from "node:net";

const REGISTERED_K8S_HOSTS = new Set<string>();

export function registerK8sEndpoint(host: string, port: number | string): void {
  REGISTERED_K8S_HOSTS.add(`${host.toLowerCase()}:${port}`);
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "metadata.google.internal") return true;
  if (net.isIPv4(lower)) {
    const [a = 0, b = 0] = lower.split(".").map((p) => Number(p));
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(lower)) {
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  return false;
}

/** Public hosts pass; private/loopback/link-local hosts must be registered. */
export function isK8sApiEndpointAllowed(hostname: string, port: number | string): boolean {
  const lower = hostname.toLowerCase();
  if (!isPrivateOrLoopbackHost(lower)) return true;
  return REGISTERED_K8S_HOSTS.has(`${lower}:${port}`);
}

/**
 * Parse a kubeconfig the main process learned from its own credential store
 * and allowlist every cluster API endpoint it names. Uses the same
 * `@kubernetes/client-node` parser as the k8s node driver, so anything the
 * driver can talk to gets registered. A malformed kubeconfig registers
 * nothing — the caller persists credentials regardless, and validation
 * errors surface when the plugin actually connects.
 */
export async function registerKubeconfigClusterEndpoints(
  kubeconfig: string | undefined,
): Promise<void> {
  if (!kubeconfig) return;
  // Dynamic import: @kubernetes/client-node is ESM-only and this file is
  // type-checked as CJS (same pattern as getSsh2Utils in main.ts).
  const { KubeConfig } = await import("@kubernetes/client-node");
  const kc = new KubeConfig();
  try {
    kc.loadFromString(kubeconfig);
  } catch {
    return;
  }
  for (const cluster of kc.getClusters()) {
    let url: URL;
    try {
      url = new URL(cluster.server);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    registerK8sEndpoint(url.hostname, port);
  }
}
