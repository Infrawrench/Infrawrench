/**
 * Whether an IP literal is a public address, for a host a user typed that a bastion
 * agent may dial. Anything that does not parse is not public, so an unexpected spelling
 * fails closed.
 *
 * The same ranges as `classifyIp` in `egress-guard.ts`, which a test holds it to. It is
 * separate because this also runs in the agent, whose image builds from its own package
 * alone, and in the edge Worker, where `net.BlockList` cannot be relied on. So this file
 * has no imports, and `bastion-agent/src/public-address.ts` is a copy of it that a test
 * keeps identical.
 */

type Range = readonly [address: readonly number[], prefixBits: number];

function v4(a: number, b: number, c: number, d: number, bits: number): Range {
  return [[a, b, c, d], bits];
}

const NOT_PUBLIC_V4: readonly Range[] = [
  v4(0, 0, 0, 0, 8), // "this network", includes the unspecified address
  v4(10, 0, 0, 0, 8), // private
  v4(100, 64, 0, 0, 10), // CGNAT
  v4(127, 0, 0, 0, 8), // loopback
  v4(169, 254, 0, 0, 16), // link-local, cloud metadata endpoints
  v4(172, 16, 0, 0, 12), // private
  v4(192, 0, 0, 0, 24), // IETF protocol assignments
  v4(192, 0, 2, 0, 24), // TEST-NET-1
  v4(192, 88, 99, 0, 24), // deprecated 6to4 relay anycast
  v4(192, 168, 0, 0, 16), // private
  v4(198, 18, 0, 0, 15), // benchmarking
  v4(198, 51, 100, 0, 24), // TEST-NET-2
  v4(203, 0, 113, 0, 24), // TEST-NET-3
  v4(224, 0, 0, 0, 4), // multicast
  v4(240, 0, 0, 0, 4), // reserved, includes limited broadcast
];

function v6(prefix: readonly number[], bits: number): Range {
  return [prefix, bits];
}

const NOT_PUBLIC_V6: readonly Range[] = [
  v6([0xfc], 7), // unique local
  v6([0xfe, 0x80], 10), // link-local
  v6([0xfe, 0xc0], 10), // deprecated site-local
  v6([0xff], 8), // multicast
  v6([0x01, 0x00, 0, 0, 0, 0, 0, 0], 64), // discard-only
  v6([0x20, 0x01, 0, 0], 32), // Teredo: the client address is obfuscated
  v6([0x20, 0x01, 0, 0x10], 28), // deprecated ORCHID
  v6([0x20, 0x01, 0x0d, 0xb8], 32), // documentation
  v6([0x3f, 0xff], 20), // documentation
  v6([0, 0x64, 0xff, 0x9b, 0, 1], 48), // local-use NAT64: the embedded address is site-defined
];

function inRange(bytes: readonly number[], [address, prefixBits]: Range): boolean {
  for (let bit = 0; bit < prefixBits; bit++) {
    const index = Math.floor(bit / 8);
    const mask = 0x80 >> (bit % 8);
    if (((bytes[index] ?? 0) & mask) !== ((address[index] ?? 0) & mask)) return false;
  }
  return true;
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // A leading zero reads as octal to some parsers, so it is not an address here.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const dotted = /(^|:)([0-9.]+)$/.exec(text);
  if (dotted?.[2]?.includes(".")) {
    const embedded = parseV4(dotted[2]);
    if (!embedded) return null;
    const high = (((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0)).toString(16);
    const low = (((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0)).toString(16);
    text = `${text.slice(0, -dotted[2].length)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string | undefined) => (half ? half.split(":") : []);
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const bytes: number[] = [];
  for (const group of [...head, ...Array<string>(fill).fill("0"), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function allZero(bytes: readonly number[], from: number, to: number): boolean {
  return bytes.slice(from, to).every((byte) => byte === 0);
}

/** The IPv4 address an IPv6 address carries, in the forms that route to one. */
function embeddedV4(bytes: readonly number[]): readonly number[] | null {
  const at = bytes.slice(12, 16);
  const ffff = (index: number) => bytes[index] === 0xff && bytes[index + 1] === 0xff;
  if (allZero(bytes, 0, 10) && ffff(10)) return at; // IPv4-mapped
  if (allZero(bytes, 0, 12)) return at; // IPv4-compatible, which also makes `::` and `::1` 0.0.0.x
  if (allZero(bytes, 0, 8) && ffff(8) && allZero(bytes, 10, 12)) return at; // SIIT
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (allZero(bytes, 4, 12)) return at; // well-known NAT64
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6); // 6to4
  return null;
}

function v4IsPublic(bytes: readonly number[]): boolean {
  if (bytes.join(".") === "100.100.100.200") return false; // Alibaba Cloud metadata
  return !NOT_PUBLIC_V4.some((range) => inRange(bytes, range));
}

export function isPublicAddress(ip: string): boolean {
  const asV4 = parseV4(ip);
  if (asV4) return v4IsPublic(asV4);
  const asV6 = parseV6(ip);
  if (!asV6) return false;
  const embedded = embeddedV4(asV6);
  if (embedded) return v4IsPublic(embedded);
  // AWS's IPv6 metadata address, which sits inside the unique local block anyway.
  return !NOT_PUBLIC_V6.some((range) => inRange(asV6, range));
}

/** Whether `host` is written as an address rather than a name. */
export function looksLikeIpAddress(host: string): boolean {
  return parseV4(host) !== null || parseV6(host) !== null || /^[0-9.]+$/.test(host);
}
