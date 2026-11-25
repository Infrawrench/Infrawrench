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
