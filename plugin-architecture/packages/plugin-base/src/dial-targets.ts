/**
 * Where a node driver's connection string makes the host open sockets.
 *
 * The cloud server runs every tenant's drivers in one shared process, so it
 * has to vet a destination before a driver dials it (no loopback, no cloud
 * metadata endpoint, no cluster-internal addresses). Only the driver knows
 * how its own connection string is laid out (a Kafka broker list, a Mongo
 * seed list, a kubeconfig), so each driver reports its targets through
 * `dialTargets` and the host applies one generic policy to the result.
 *
 * The desktop app never calls `dialTargets`: it is single-user and keeps
 * reaching LAN and loopback services directly.
 */
export type DialTarget =
  /** A TCP destination: a hostname or an IP literal, plus the port. */
  | { kind: "host"; host: string; port: number }
  /** A DNS SRV name whose answers are the real destinations (`mongodb+srv`). */
  | { kind: "srv"; name: string }
  /**
   * Something that is not a network destination at all: a unix socket, a
   * file the driver would read, or a string the driver could not parse.
   * A shared server refuses these outright.
   */
  | { kind: "local"; reason: string };

/** Strip the brackets WHATWG `URL` keeps around an IPv6 literal hostname. */
export function unbracketHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Split a `host[:port]` token (IPv6 literals bracketed) into a dial target.
 * Used by drivers whose connection strings are comma-separated server lists.
 */
export function hostPortDialTarget(token: string, defaultPort: number): DialTarget {
  const trimmed = token.trim();
  const at = trimmed.lastIndexOf("@");
  const hostPort = at === -1 ? trimmed : trimmed.slice(at + 1);
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (bracketed) {
    return {
      kind: "host",
      host: bracketed[1]!,
      port: bracketed[2] ? Number(bracketed[2]) : defaultPort,
    };
  }
  const plain = /^([^:/\s]+)(?::(\d+))?$/.exec(hostPort);
  if (!plain) return { kind: "local", reason: `unrecognised server address "${hostPort}"` };
  return { kind: "host", host: plain[1]!, port: plain[2] ? Number(plain[2]) : defaultPort };
}

/**
 * The single host a URL-shaped connection string points at. Returns a
 * `local` target when the URL has no host, which for most database clients
 * means "fall back to the default unix socket".
 */
export function urlDialTarget(url: URL, defaultPort: number): DialTarget {
  const host = unbracketHost(url.hostname);
  if (!host) return { kind: "local", reason: `${url.protocol} URL has no host` };
  return { kind: "host", host, port: url.port ? Number(url.port) : defaultPort };
}
