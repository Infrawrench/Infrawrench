/**
 * Outbound guard for cost export destinations.
 *
 * A destination is a URL an org member typed, and the request to it leaves
 * from the poller or web pod, inside the cluster. Unguarded, that is a request
 * to `169.254.169.254` (the node's metadata credentials) or to any other pod,
 * and because a failed run's status is shown back to the user, a read oracle
 * besides. So every destination request goes through {@link destinationFetch}:
 *
 *  - **https only, no userinfo**, checked on the parsed URL;
 *  - **no private, loopback, link-local or otherwise reserved address**,
 *    checked on a literal IP before the request and, for a hostname, inside the
 *    socket's own DNS lookup. Doing it in the lookup is what pins the address:
 *    the answer that was vetted is the one the socket connects to, so a
 *    short-TTL record cannot pass the check with a public IP and then connect
 *    to a private one;
 *  - **no redirects**. A 3xx comes back as a non-2xx response and fails the
 *    upload, rather than being followed to wherever it points.
 *
 * The egress proxy (`app/packages/egress-proxy`) was the other option. It takes
 * a buffered JSON envelope, which fits a workflow's `fetch()` but not an 8 MiB
 * multipart part or a streamed HTTPS body, so the guard lives here instead.
 * It is deliberately self-contained and can be swapped for a shared server-side
 * dial guard once one exists.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

/** Thrown when a destination URL or its address is refused. */
export class DestinationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationRefusedError";
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  // No `::ffff:0:0/96` rule: BlockList already checks an IPv4-mapped address
  // against the IPv4 rules above, and such a rule would match every IPv4.
  ["64:ff9b::", 96], // NAT64, which maps onto IPv4 space
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated, still routable in places)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True when `ip` is an address a destination must never resolve to. Unparseable is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6");
  return true;
}

/** Strip the brackets `URL.hostname` keeps around an IPv6 literal. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Parse a destination URL and refuse anything that is not plain `https` to a
 * non-internal host. `what` names the field in the error. Returns the parsed
 * URL; callers that must send the original string byte-for-byte (a pre-signed
 * URL) still send the original.
 */
export function assertDestinationUrl(raw: string, what = "destination URL"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DestinationRefusedError(`${what} must be an absolute https:// URL`);
  }
  if (url.protocol !== "https:") throw new DestinationRefusedError(`${what} must use https`);
  if (url.username || url.password) {
    throw new DestinationRefusedError(`${what} must not contain a username or password`);
  }
  const host = bareHost(url.hostname);
  if (!host) throw new DestinationRefusedError(`${what} has no host`);
  // A literal IP never reaches the DNS lookup below (the socket connects to it
  // directly), so this is the only place one is checked.
  if (isIP(host) && isBlockedAddress(host)) {
    throw new DestinationRefusedError(`${what} points at a private or reserved address`);
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new DestinationRefusedError(`${what} points at a private or reserved address`);
  }
  return url;
}

/**
 * A `net.connect` lookup that refuses a name when *any* of its answers is in
 * blocked space (a name that returns both a public and a private address is
 * straddling the check), and otherwise hands the socket the vetted answers.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      callback(
        new DestinationRefusedError("destination resolves to a private or reserved address"),
        "",
        0,
      );
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
};

let agent: Agent | null = null;
function guardedAgent(): Agent {
  agent ??= new Agent({ connect: { lookup: guardedLookup } });
  return agent;
}

/**
 * `fetch` for a destination request: the URL is checked, the connection goes
 * through the guarded lookup, and redirects are returned rather than followed.
 * Signature-compatible with the global `fetch` so it can be handed to
 * `signedS3Fetch`.
 */
export async function destinationFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assertDestinationUrl(raw);
  const res = await undiciFetch(raw, {
    ...(init as unknown as UndiciRequestInit),
    redirect: "manual",
    dispatcher: guardedAgent(),
  });
  return res as unknown as Response;
}

/**
 * S3 region. It becomes a hostname label (`s3.<region>.amazonaws.com`) and part
 * of the SigV4 scope, so it is held to the characters a real region uses.
 */
export const S3_REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * Validate an S3-compatible endpoint (a bare host or an `https://` origin, with
 * an optional port) and return it as an origin. Empty in, empty out: that means
 * AWS S3 proper.
 */
export function normalizeS3Endpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = assertDestinationUrl(withScheme, "destination.endpoint");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new DestinationRefusedError("destination.endpoint must be a host or https:// origin");
  }
  return url.origin;
}
