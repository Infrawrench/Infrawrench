/**
 * Which responses get the renderer-side CORS relaxation in main.ts.
 *
 * Plugins run in the renderer and call provider APIs directly with `fetch`;
 * many of those APIs send no CORS headers (AWS, GCP compute) or an allow-list
 * that omits their own SDK's headers, so main rewrites the response headers
 * for them. The provider set is open-ended (dozens of plugins, plus
 * user-chosen endpoints such as a self-hosted OpenSearch or a regional API),
 * so it cannot be a fixed `urls` filter.
 *
 * What must not get it is this machine and the user's private network: with
 * `Access-Control-Allow-Origin: *` on every response, any script in the
 * renderer can read the local Docker API on a TCP port, a router admin page,
 * or cloud metadata. So a response whose server address is loopback, private
 * or link-local is relaxed only when its host:port is one the user configured
 * (a URL or host in a stored account's credentials), the local end of an SSH
 * tunnel main opened, or the cloud API itself.
 */
import { isPrivateAddress, isPrivateOrLoopbackHost } from "./k8s-endpoints";

const CREDENTIAL_HOSTS = new Set<string>();
/** Hosts named without a port: any port on them is user-configured. */
const CREDENTIAL_HOSTS_ANY_PORT = new Set<string>();

function defaultPort(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : "80";
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const BARE_HOST_PATTERN =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:(\d{1,5}))?$/i;

/**
 * Register every endpoint a stored account's credentials name: URLs anywhere
 * in a value, and values that are just a host or host:port. Called where
 * main decrypts or writes credentials, the same trust model as the k8s
 * allowlist in k8s-endpoints.ts.
 */
export function registerCredentialEndpoints(credentials: Record<string, unknown>): void {
  for (const raw of Object.values(credentials)) {
    if (typeof raw !== "string" || raw.length > 64 * 1024) continue;
    for (const match of raw.matchAll(URL_PATTERN)) {
      let url: URL;
      try {
        url = new URL(match[0]);
      } catch {
        continue;
      }
      if (!url.hostname) continue;
      CREDENTIAL_HOSTS.add(
        `${normalizeHost(url.hostname)}:${url.port || defaultPort(url.protocol)}`,
      );
    }
    const bare = BARE_HOST_PATTERN.exec(raw.trim());
    if (bare?.[1]) {
      const host = normalizeHost(bare[1]);
      if (bare[6]) CREDENTIAL_HOSTS.add(`${host}:${bare[6]}`);
      // A bare "localhost" would open every local port; it needs a port.
      else if (!isLoopbackName(host)) CREDENTIAL_HOSTS_ANY_PORT.add(host);
    }
  }
}

/** Whether a stored account's credentials name this host:port. */
export function isCredentialEndpoint(hostname: string, port: number | string): boolean {
  const host = normalizeHost(hostname);
  return CREDENTIAL_HOSTS.has(`${host}:${port}`) || CREDENTIAL_HOSTS_ANY_PORT.has(host);
}

export interface CorsCandidate {
  url: string;
  /**
   * What the hostname resolves to. `onHeadersReceived` does not report the
   * address Chromium connected to, so main resolves the name itself (see
   * {@link createHostResolver}).
   */
  addresses?: readonly string[] | undefined;
}

export interface CorsContext {
  /** Local ports of SSH tunnels main has open. */
  tunnelPorts: number[];
  /** Origin of the Infrawrench cloud API. */
  cloudOrigin: string;
}

/** Whether main may add permissive CORS headers to this response. */
export function shouldRelaxCors(candidate: CorsCandidate, context: CorsContext): boolean {
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.origin === context.cloudOrigin) return true;
  const host = normalizeHost(url.hostname);
  const isPrivate =
    isPrivateOrLoopbackHost(host) || (candidate.addresses ?? []).some((a) => isPrivateAddress(a));
  if (!isPrivate) return true;
  const port = url.port || defaultPort(url.protocol);
  if (isCredentialEndpoint(host, port)) return true;
  return isLoopbackName(host) && context.tunnelPorts.includes(Number(port));
}

function isLoopbackName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isPrivateAddress(host) && /^(127\.|0\.0\.0\.0$|::1?$|::ffff:127\.)/.test(host))
  );
}

/**
 * Cached `hostname -> addresses` resolution for the CORS hook, so a public
 * name pointed at 127.0.0.1 or a private range is treated as private. Cached
 * briefly because the hook runs on every response. A failed lookup yields no
 * addresses (the literal-hostname check still applies).
 */
export function createHostResolver(
  lookupAll: (hostname: string) => Promise<string[]>,
  ttlMs = 60_000,
  now: () => number = Date.now,
): (hostname: string) => Promise<string[]> {
  const cache = new Map<string, { at: number; addresses: string[] }>();
  return async (hostname) => {
    const host = normalizeHost(hostname);
    if (isPrivateOrLoopbackHost(host) || isPrivateAddress(host) || /^[\d.]+$|:/.test(host)) {
      return [];
    }
    const hit = cache.get(host);
    if (hit && now() - hit.at < ttlMs) return hit.addresses;
    const addresses = await lookupAll(host).catch((): string[] => []);
    if (cache.size > 1000) cache.clear();
    cache.set(host, { at: now(), addresses });
    return addresses;
  };
}

/** Test hook: the registry is module state. */
export function resetCredentialEndpointsForTest(): void {
  CREDENTIAL_HOSTS.clear();
  CREDENTIAL_HOSTS_ANY_PORT.clear();
}
