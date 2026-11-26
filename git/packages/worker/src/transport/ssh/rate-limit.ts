/**
 * Slows down an address that keeps failing to authenticate over SSH.
 *
 * The count is kept in the Cache API, which is per data centre and may
 * forget early. That is the right weight for this: an address reaches the
 * same data centre from one request to the next, the limit only has to make
 * guessing expensive (a key is not guessable anyway), and a Durable Object
 * here would put a storage round trip in front of every SSH connection for
 * everyone. A lost count lets an attacker try a little longer; it never
 * locks anyone out.
 */

export interface FailureLimits {
  /** Failed connections allowed in a window before the address is refused. */
  readonly maxFailures: number;
  readonly windowSeconds: number;
}

export const DEFAULT_FAILURE_LIMITS: FailureLimits = { maxFailures: 20, windowSeconds: 600 };

/** The part of `Cache` this uses. */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
}

/** The data centre's cache, where the runtime has one. */
export function defaultCache(): CacheLike | null {
  return (globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null;
}

export interface FailureLimiter {
  /** Whether new connections from this address are refused for now. */
  blocked(address: string): Promise<boolean>;
  /** Records a connection that ended without authenticating. */
  failed(address: string): Promise<void>;
}

interface Record {
  readonly count: number;
  /** When the window ends, milliseconds. */
  readonly until: number;
}

/** A connect address without its port: `203.0.113.7:51234`, `[2001:db8::1]:51234`. */
export function addressKey(remote: string | undefined): string | null {
  if (!remote) return null;
  const bracket = /^\[([^\]]+)\]/.exec(remote);
  if (bracket) return bracket[1]!;
  const colon = remote.lastIndexOf(":");
  // More than one colon and no brackets is a bare IPv6 address, which has no port to drop.
  if (colon < 0 || remote.indexOf(":") !== colon) return remote;
  return remote.slice(0, colon);
}

/**
 * What failures are counted against: an IPv4 address as it is, an IPv6
 * address as its /64. One customer line is given a whole /64, so counting
 * single IPv6 addresses would let a client start afresh with every
 * connection. An IPv4 address written inside IPv6 (`::ffff:203.0.113.7`)
 * counts as that IPv4 address. Anything that does not parse is used as it is.
 */
export function rateLimitKey(address: string): string {
  const host = address.replace(/%.*$/, "").toLowerCase();
  if (!host.includes(":")) return host;
  const groups = expandIpv6(host);
  if (!groups) return host;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function expandIpv6(text: string): number[] | null {
  let rest = text;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(rest);
  if (dotted) {
    const bytes = dotted.slice(2, 6).map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    tail.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
    rest = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const back = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !back) return null;
  const known = head.length + back.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...head, ...new Array<number>(8 - known).fill(0), ...back, ...tail];
  }
  return known === 8 ? [...head, ...tail] : null;
}

export function cacheFailureLimiter(
  cache: CacheLike | null,
  limits: FailureLimits = DEFAULT_FAILURE_LIMITS,
  now: () => number = Date.now,
): FailureLimiter {
  const key = (address: string): string =>
    `https://ssh-auth-failures.invalid/${encodeURIComponent(address)}`;
  const read = async (address: string): Promise<Record | null> => {
    const hit = await cache?.match(key(address)).catch(() => undefined);
    if (!hit) return null;
    const record = (await hit.json().catch(() => null)) as Record | null;
    return record && record.until > now() ? record : null;
  };
  return {
    blocked: async (address) => ((await read(address))?.count ?? 0) >= limits.maxFailures,
    failed: async (address) => {
      if (!cache) return;
      const current = await read(address);
      const record: Record = {
        count: (current?.count ?? 0) + 1,
        until: current?.until ?? now() + limits.windowSeconds * 1000,
      };
      const ttl = Math.max(1, Math.ceil((record.until - now()) / 1000));
      await cache
        .put(
          key(address),
          new Response(JSON.stringify(record), {
            headers: { "Cache-Control": `max-age=${ttl}`, "Content-Type": "application/json" },
          }),
        )
        .catch(() => undefined);
    },
  };
}
