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
 * learns it from a kubeconfig in the user's credential store; the encrypted
 * accounts table that only main can decrypt (see the account_* handlers in
 * main.ts). Adding a cluster there is a deliberate user action through the
 * credential UI, so its API endpoints (e.g. a minikube at 127.0.0.1 or a
 * VPN'd cluster at 10.x.x.x) are user-intended. Nothing in this module is
 * reachable from a renderer-supplied URL: there is deliberately no IPC that
 * registers an endpoint directly.
 */
import net from "node:net";
import dns from "node:dns";

const REGISTERED_K8S_HOSTS = new Set<string>();

export function registerK8sEndpoint(host: string, port: number | string): void {
  REGISTERED_K8S_HOSTS.add(`${host.toLowerCase()}:${port}`);
}

/**
 * Address ranges a renderer must not reach through a main-process proxy
 * without the user having named them: loopback, RFC 1918, CGNAT, link-local
 * (cloud metadata), unique-local IPv6, and the unspecified addresses that
 * Linux routes to the local host. BlockList also matches IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`) against the IPv4 subnets.
 */
const PRIVATE_ADDRESSES = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(prefix, bits, "ipv6");
}

/** True for a literal IP address in a loopback, private or link-local range. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = net.isIP(bare);
  if (family === 4) return PRIVATE_ADDRESSES.check(bare, "ipv4");
  if (family === 6) return PRIVATE_ADDRESSES.check(bare, "ipv6");
  return false;
}

/** Literal check: names that are local by definition, or private IP literals. */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "metadata.google.internal") return true;
  return isPrivateAddress(lower);
}

/**
 * Literal-hostname check: public hosts pass; private/loopback/link-local hosts
 * must be registered. Callers that go on to connect must use
 * {@link resolveK8sApiEndpoint} instead, which also vets what the name
 * resolves to.
 */
export function isK8sApiEndpointAllowed(hostname: string, port: number | string): boolean {
  const lower = hostname.toLowerCase();
  if (!isPrivateOrLoopbackHost(lower)) return true;
  return REGISTERED_K8S_HOSTS.has(`${lower}:${port}`);
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookupAll: LookupAll = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve `hostname` and decide whether a request to it may proceed.
 *
 * A literal check alone is bypassed by any public name whose A record points
 * at 127.0.0.1 or 169.254.169.254, so every resolved address is checked, and
 * the caller connects to the returned address rather than resolving again
 * (which would let a short-TTL record answer differently the second time).
 * A registered host:port skips the address check: the user put that cluster
 * in their own kubeconfig, private address and all. `trusted` does the same
 * for endpoints the caller knows the user configured some other way.
 */
export async function resolveK8sApiEndpoint(
  hostname: string,
  port: number | string,
  options: { lookupAll?: LookupAll; trusted?: boolean } = {},
): Promise<ResolvedAddress> {
  const lookupAll = options.lookupAll ?? defaultLookupAll;
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const registered = options.trusted === true || REGISTERED_K8S_HOSTS.has(`${lower}:${port}`);
  if (!registered && isPrivateOrLoopbackHost(lower)) {
    throw new Error(`refused private/loopback host "${hostname}"`);
  }
  const family = net.isIP(lower);
  if (family) return { address: lower, family };
  const addresses = await lookupAll(lower);
  if (addresses.length === 0) throw new Error(`could not resolve "${hostname}"`);
  if (!registered) {
    const blocked = addresses.find((a) => isPrivateAddress(a.address));
    if (blocked) {
      throw new Error(
        `refused "${hostname}": it resolves to the private/loopback address ${blocked.address}`,
      );
    }
  }
  return addresses[0] as ResolvedAddress;
}

/**
 * Parse a kubeconfig the main process learned from its own credential store
 * and allowlist every cluster API endpoint it names. Uses the same
 * `@kubernetes/client-node` parser as the k8s node driver, so anything the
 * driver can talk to gets registered. A malformed kubeconfig registers
 * nothing: the caller persists credentials regardless, and validation
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
