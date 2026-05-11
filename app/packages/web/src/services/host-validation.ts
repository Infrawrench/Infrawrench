/**
 * SSRF protection helpers for SSH tunnel endpoints.
 *
 * Resolves a hostname via DNS and rejects if any resulting IP falls in a
 * reserved/private range (RFC1918, loopback, link-local, etc.). Applied to
 * the bastion endpoint (`sshHost`) of an SSH tunnel, where the server itself
 * is the one making the outbound connection. Inner `remoteHost` is _not_
 * validated — reaching private hosts via the bastion is the whole point.
 */
import { promises as dns } from "node:dns";
import net from "node:net";

/**
 * Parse an IPv4 address into a 32-bit unsigned integer. Returns null if not
 * a valid dotted-quad.
 */
function ipv4ToInt(ip: string): number | null {
  if (net.isIPv4(ip) !== true) return null;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return (
    ((parts[0]! << 24) >>> 0) + ((parts[1]! << 16) >>> 0) + ((parts[2]! << 8) >>> 0) + parts[3]!
  );
}

function inCidr(ipInt: number, cidrStart: string, prefix: number): boolean {
  const startInt = ipv4ToInt(cidrStart);
  if (startInt === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (startInt & mask);
}

/**
 * Returns true if the given IP address (v4 or v6) is in a private,
 * loopback, link-local, multicast, broadcast, or otherwise reserved range
 * that the server should not be connecting outbound to.
 */
function isBlockedIp(ip: string): boolean {
  // IPv6: block loopback, link-local, unique-local, mapped-IPv4 to blocked v4.
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped IPv6 (::ffff:1.2.3.4) — extract and recheck as v4.
    const mappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedMatch?.[1]) return isBlockedIp(mappedMatch[1]);
    return false;
  }

  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return true; // unparseable — refuse

  // Reserved IPv4 ranges
  const blockedRanges: Array<[string, number]> = [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // RFC1918
    ["100.64.0.0", 10], // CGNAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local
    ["172.16.0.0", 12], // RFC1918
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // TEST-NET-1
    ["192.168.0.0", 16], // RFC1918
    ["198.18.0.0", 15], // benchmark
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved future / "limited broadcast" 255.255.255.255
  ];
  for (const [start, prefix] of blockedRanges) {
    if (inCidr(ipInt, start, prefix)) return true;
  }
  return false;
}

/**
 * Resolve `host` via DNS and throw if it resolves to (or already is) a
 * blocked address. Hostnames with no A/AAAA records are also rejected.
 */
export async function assertHostNotInternal(host: string): Promise<void> {
  const trimmed = host.trim();
  if (!trimmed) throw new Error("SSH host is required");

  // If literal IP, check directly without DNS.
  if (net.isIP(trimmed)) {
    if (isBlockedIp(trimmed)) {
      throw new Error(`SSH host ${trimmed} resolves to a blocked address range`);
    }
    return;
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(trimmed, { all: true });
  } catch (e) {
    throw new Error(
      `Failed to resolve SSH host ${trimmed}: ${e instanceof Error ? e.message : "DNS error"}`,
    );
  }
  if (addrs.length === 0) {
    throw new Error(`SSH host ${trimmed} did not resolve to any address`);
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`SSH host ${trimmed} resolves to a blocked address (${a.address})`);
    }
  }
}
