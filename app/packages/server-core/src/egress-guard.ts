/**
 * Egress guard for every connection the shared server makes to a
 * tenant-supplied destination.
 *
 * The web and poller pods run every organization's plugin clients, database
 * drivers and SSH sessions in one process, inside the cluster network. A
 * destination a tenant typed (a Redis URL, a Databricks host, a kubeconfig
 * `server`, an SSH host) would otherwise reach whatever that process can:
 * loopback services, the cloud metadata endpoint, the kubelet, ClickHouse,
 * other pods, and the loopback listeners of SSH tunnels other organizations
 * opened. This module is the one place that decides what is reachable.
 *
 * Policy, in order:
 *  - Always refused: loopback, unspecified, link-local (cloud metadata lives
 *    there), multicast, broadcast and the other special-purpose ranges, plus
 *    the cluster's own CIDRs from `EGRESS_BLOCKED_CIDRS`.
 *  - Private customer space (RFC 1918, CGNAT, IPv6 ULA) is refused unless
 *    `EGRESS_ALLOW_PRIVATE_NETWORKS` is set. With it refused, a private host
 *    is reached through a bastion agent or an SSH tunnel instead.
 *  - The single exception to the loopback rule is the local end of an SSH
 *    tunnel owned by the same account or organization as the caller. The
 *    tunnel resolver rewrites a connection to `127.0.0.1:<port>`; a tenant who
 *    types that address themselves is still refused, because the port has to
 *    belong to a tunnel opened for *their* scope.
 *
 * IPv6 is normalised to bytes before any range check, so every spelling of
 * an address (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, `::ffff:127.0.0.1`,
 * `64:ff9b::a9fe:a9fe`, a 6to4 prefix) is judged by the IPv4 address it
 * embeds when it embeds one.
 *
 * This module lives in server-core and is imported only by server processes.
 * The desktop app is single-user, never loads it, and keeps reaching LAN and
 * loopback services directly.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as dns, type LookupAddress } from "node:dns";
import net from "node:net";
import type { DialTarget } from "@infrawrench/plugin-base";
import type { TunnelExtras } from "@infrawrench/ssh-tunnel-core";
import { Agent, Dispatcher, buildConnector, setGlobalDispatcher } from "undici";

/** Who a connection is being made for. Used only to recognise its own tunnels. */
export interface DialScope {
  organizationId?: string | undefined;
  accountId?: string | undefined;
}

/** Thrown when a destination is refused. Messages are safe to show the user. */
export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressBlockedError";
  }
}

type AddressClass = "public" | "private" | "internal";

// --- range tables -----------------------------------------------------------

/** Never reachable from the shared server, whatever the configuration. */
const INTERNAL_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network", includes the unspecified address
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata endpoints
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes limited broadcast 255.255.255.255
  ["100.100.100.200", 32], // Alibaba Cloud metadata, which sits inside CGNAT space
];

/** Customer private space: refused unless private networks are allowed. */
const PRIVATE_V4: Array<[string, number]> = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

const INTERNAL_V6: Array<[string, number]> = [
  ["fe80::", 10], // link-local: fe80:: through febf::
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo: the client address is obfuscated, judge it unreachable
  ["2001:10::", 28], // deprecated ORCHID
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation
  ["64:ff9b:1::", 48], // local-use NAT64: the embedded address is site-defined
  ["fd00:ec2::254", 128], // AWS IMDS over IPv6, which sits inside ULA space
];

const PRIVATE_V6: Array<[string, number]> = [["fc00::", 7]]; // unique local

// --- policy ---------------------------------------------------------------

interface Policy {
  allowPrivate: boolean;
  internal: net.BlockList;
  private: net.BlockList;
}

let cachedPolicy: { key: string; policy: Policy } | null = null;

function parseCidr(raw: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } {
  const [address = "", prefixText] = raw.split("/");
  const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
  const max = family === "ipv4" ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    // Fail loudly: a typo here would otherwise silently leave the cluster
    // reachable, which is the one thing this setting exists to prevent.
    throw new Error(`EGRESS_BLOCKED_CIDRS: "${raw}" is not a valid CIDR`);
  }
  return { address, prefix, family };
}

function buildPolicy(): Policy {
  const blockedCidrs = process.env.EGRESS_BLOCKED_CIDRS ?? "";
  const allowPrivateRaw = (process.env.EGRESS_ALLOW_PRIVATE_NETWORKS ?? "").trim().toLowerCase();
  const key = `${blockedCidrs}\u0000${allowPrivateRaw}`;
  if (cachedPolicy?.key === key) return cachedPolicy.policy;

  const internal = new net.BlockList();
  for (const [a, p] of INTERNAL_V4) internal.addSubnet(a, p, "ipv4");
  for (const [a, p] of INTERNAL_V6) internal.addSubnet(a, p, "ipv6");
  for (const raw of blockedCidrs.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const { address, prefix, family } = parseCidr(trimmed);
    internal.addSubnet(address, prefix, family);
  }
  const priv = new net.BlockList();
  for (const [a, p] of PRIVATE_V4) priv.addSubnet(a, p, "ipv4");
  for (const [a, p] of PRIVATE_V6) priv.addSubnet(a, p, "ipv6");

  const policy: Policy = {
    allowPrivate: allowPrivateRaw === "true" || allowPrivateRaw === "1",
    internal,
    private: priv,
  };
  cachedPolicy = { key, policy };
  return policy;
}

// --- IPv6 normalisation ---------------------------------------------------

/** Parse an IPv6 literal (zone id allowed) into 16 bytes, or null. */
function parseIPv6(ip: string): Uint8Array | null {
  const noZone = ip.split("%")[0]!;
  if (!net.isIPv6(noZone)) return null;
  let text = noZone.toLowerCase();
  // An embedded dotted quad takes the last two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = dotted[1]!.split(".").map(Number);
    text =
      text.slice(0, -dotted[1]!.length) +
      `${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  });
  return bytes;
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

function v4At(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

/**
 * The IPv4 address an IPv6 address stands for, when it is one of the forms
 * that carry one: IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::/96`,
 * which also turns `::` and `::1` into 0.0.0.0 and 0.0.0.1), SIIT
 * (`::ffff:0:0:0/96`), well-known NAT64 (`64:ff9b::/96`) and 6to4
 * (`2002::/16`).
 */
function embeddedIPv4(bytes: Uint8Array): string | null {
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4At(bytes, 12);
  if (allZero(bytes, 0, 12)) return v4At(bytes, 12);
  if (allZero(bytes, 0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && allZero(bytes, 10, 12)) {
    return v4At(bytes, 12);
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (allZero(bytes, 4, 12)) return v4At(bytes, 12);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4At(bytes, 2);
  return null;
}

function formatIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return groups.join(":");
}

/**
 * Classify an IP literal. Anything that does not parse is `internal`, so an
 * unexpected spelling fails closed.
 */
export function classifyIp(ip: string): AddressClass {
  const policy = buildPolicy();
  if (net.isIPv4(ip)) {
    if (policy.internal.check(ip, "ipv4")) return "internal";
    if (policy.private.check(ip, "ipv4")) return "private";
    return "public";
  }
  const bytes = parseIPv6(ip);
  if (!bytes) return "internal";
  const v4 = embeddedIPv4(bytes);
  if (v4) {
    // 6to4 and NAT64 wrap a v4 address that is itself public or not; the
    // v6 prefix around it adds nothing to reachability.
    return classifyIp(v4);
  }
  const canonical = formatIPv6(bytes);
  if (policy.internal.check(canonical, "ipv6")) return "internal";
  if (policy.private.check(canonical, "ipv6")) return "private";
  return "public";
}

/** True when the configured policy refuses `ip` (ignoring the tunnel exception). */
export function isBlockedIp(ip: string): boolean {
  const cls = classifyIp(ip);
  if (cls === "internal") return true;
  if (cls === "private") return !buildPolicy().allowPrivate;
  return false;
}

/**
 * True when `ip:port` is the local end of an SSH tunnel opened for the same
 * account or organization as `scope`. Only the literal address the tunnel
 * resolver writes counts; a name that resolves to loopback never does.
 */
async function isOwnTunnelEndpoint(
  ip: string,
  port: number | undefined,
  scope?: DialScope,
): Promise<boolean> {
  if (!scope || port === undefined || ip !== "127.0.0.1") return false;
  const { accountId, organizationId } = scope;
  if (!accountId && !organizationId) return false;
  // Loaded on demand: the tunnel registry pulls in ssh2, which nothing else
  // on the guard's path needs.
  const { findTunnel } = await import("@infrawrench/ssh-tunnel-core");
  return (
    findTunnel<Partial<TunnelExtras> | undefined>(
      (rec) =>
        rec.localPort === port &&
        ((!!accountId && rec.extras?.accountId === accountId) ||
          (!!organizationId && rec.extras?.organizationId === organizationId)),
    ) !== null
  );
}

function refusal(label: string, host: string, address: string): EgressBlockedError {
  const literal = address === host;
  const base = literal
    ? `${label} ${host} resolves to a blocked address range`
    : `${label} ${host} resolves to a blocked address (${address})`;
  const hint =
    classifyIp(address) === "private"
      ? "; private networks are reachable from the cloud only through a bastion or an SSH tunnel"
      : "";
  return new EgressBlockedError(base + hint);
}

export interface ResolveDialOptions {
  /** Used to recognise the caller's own SSH tunnels. */
  scope?: DialScope | undefined;
  /** Noun for error messages, e.g. "SSH host". */
  label?: string;
}

/**
 * Resolve `host`, refuse it if any answer is outside the policy, and return
 * the address that was cleared.
 *
 * Callers should connect to the RETURNED address rather than resolving the
 * name again: a short-TTL record can answer this lookup with a public address
 * and the connect-time lookup with 169.254.169.254. Every answer has to be
 * clean, not just the one returned, so a name cannot straddle the check.
 */
export async function resolveDialAddress(
  host: string,
  port: number | undefined,
  options: ResolveDialOptions = {},
): Promise<string> {
  const label = options.label ?? "Host";
  let trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) trimmed = trimmed.slice(1, -1);
  if (!trimmed) throw new EgressBlockedError(`${label} is required`);

  if (net.isIP(trimmed)) {
    if (await isOwnTunnelEndpoint(trimmed, port, options.scope)) return trimmed;
    if (isBlockedIp(trimmed)) throw refusal(label, trimmed, trimmed);
    return trimmed;
  }

  let addrs: LookupAddress[];
  try {
    addrs = await dns.lookup(trimmed, { all: true });
  } catch (e) {
    throw new Error(
      `Failed to resolve ${label} ${trimmed}: ${e instanceof Error ? e.message : "DNS error"}`,
      { cause: e },
    );
  }
  if (addrs.length === 0) {
    throw new Error(`${label} ${trimmed} did not resolve to any address`);
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw refusal(label, trimmed, a.address);
  }
  return addrs[0]!.address;
}

/**
 * Vet an SSH destination and return the address to dial. The pinned address
 * goes to the socket; host-key identity stays the configured name.
 */
export function resolveSafeHost(host: string): Promise<string> {
  return resolveDialAddress(host, undefined, { label: "SSH host" });
}

/** Vet every destination a driver reported for one connection string. */
export async function assertDialTargetsAllowed(
  targets: DialTarget[],
  options: ResolveDialOptions = {},
): Promise<void> {
  const label = options.label ?? "Connection";
  if (targets.length === 0) {
    throw new EgressBlockedError(`${label} does not name a host to connect to`);
  }
  for (const target of targets) {
    if (target.kind === "local") {
      throw new EgressBlockedError(
        `${label} uses ${target.reason}, which the cloud server does not connect to. ` +
          "Use a network address, reached through a bastion or an SSH tunnel if it is private.",
      );
    }
    if (target.kind === "host") {
      await resolveDialAddress(target.host, target.port, { ...options, label });
      continue;
    }
    let records: Array<{ name: string; port: number }>;
    try {
      records = await dns.resolveSrv(target.name);
    } catch (e) {
      throw new Error(
        `Failed to resolve ${target.name}: ${e instanceof Error ? e.message : "DNS error"}`,
        { cause: e },
      );
    }
    for (const r of records) {
      await resolveDialAddress(r.name, r.port, { ...options, label });
    }
  }
}

/**
 * A node driver as far as the guard is concerned: anything that can report
 * where a connection string points. Drivers own their connection-string
 * formats; the guard owns the policy.
 */
export interface DialTargetSource {
  readonly id: string;
  dialTargets?(connection: string): DialTarget[];
}

/**
 * Refuse a driver connection whose destinations fall outside the policy.
 *
 * This validates; it does not pin. The drivers resolve the name again when
 * they connect, so a rebinding record could still swap the address in
 * between. Pinning needs per-driver support for a custom lookup or a
 * separate TLS servername, which most of these clients lack.
 */
export async function guardDriverConnection(
  driver: DialTargetSource,
  connection: string,
  scope?: DialScope,
): Promise<void> {
  if (!driver.dialTargets) {
    throw new EgressBlockedError(
      `The ${driver.id} driver does not declare where it connects, so the cloud server will not run it`,
    );
  }
  await assertDialTargetsAllowed(driver.dialTargets(connection), { scope, label: "Connection" });
}

// --- HTTP -----------------------------------------------------------------

/**
 * The scope of the plugin code currently running. Set around plugin client
 * calls and the plugin HTTP host service; HTTP made outside it (the server's
 * own calls to its database, ClickHouse, WorkOS) is not tenant-directed and
 * is left alone.
 */
const egressScope = new AsyncLocalStorage<DialScope>();

export function runInEgressScope<T>(scope: DialScope, fn: () => T): T {
  ensureEgressGuardInstalled();
  return egressScope.run(scope, fn);
}

/**
 * Wrap a plugin client so every method call runs inside `scope`. Plugins
 * that call the global `fetch` themselves (a self-hosted Databricks
 * workspace, an OpenSearch endpoint) then reach the guarded dispatcher, not
 * the raw network.
 */
export function withEgressScope<T extends object>(client: T, scope: DialScope): T {
  ensureEgressGuardInstalled();
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]) {
        return egressScope.run(scope, () =>
          (value as (...a: unknown[]) => unknown).apply(this === receiver ? target : this, args),
        );
      };
    },
  });
}

let installed = false;

/**
 * Replace undici's global dispatcher (which Node's built-in `fetch` uses)
 * with one that routes requests made inside an egress scope through a
 * per-scope agent whose connector vets and pins every destination,
 * redirects included. Requests outside any scope keep a plain agent.
 *
 * Per-scope agents rather than one shared guarded agent because undici pools
 * keep-alive connections by origin: with one pool, a tenant's request to
 * `http://127.0.0.1:<port>` would ride a connection another organization's
 * tunnel-routed request had already opened, and never reach the connector.
 */
export function ensureEgressGuardInstalled(): void {
  if (installed) return;
  const plain = new Agent();
  const scoped = new Map<string, Agent>();
  const MAX_SCOPED_AGENTS = 256;
  const baseConnect = buildConnector({});

  const agentFor = (scope: DialScope): Agent => {
    const key = `${scope.organizationId ?? ""}\u0000${scope.accountId ?? ""}`;
    const existing = scoped.get(key);
    if (existing) return existing;
    if (scoped.size >= MAX_SCOPED_AGENTS) {
      const oldest = scoped.entries().next().value;
      if (oldest) {
        scoped.delete(oldest[0]);
        void oldest[1].close().catch(() => {});
      }
    }
    const agent = new Agent({
      connect: (opts, cb) => {
        const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
        resolveDialAddress(opts.hostname, port, { scope, label: "HTTP host" }).then(
          // Only the socket address changes: undici derives SNI and the
          // certificate check from `opts.host`, the original authority.
          (address) => baseConnect({ ...opts, hostname: address }, cb),
          (err: Error) => cb(err, null),
        );
      },
    });
    scoped.set(key, agent);
    return agent;
  };

  class EgressRoutingDispatcher extends Dispatcher {
    override dispatch(
      opts: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ): boolean {
      const scope = egressScope.getStore();
      return (scope ? agentFor(scope) : plain).dispatch(opts, handler);
    }
    override async close(): Promise<void> {
      await Promise.all([plain.close(), ...[...scoped.values()].map((a) => a.close())]);
    }
    override async destroy(): Promise<void> {
      await Promise.all([plain.destroy(), ...[...scoped.values()].map((a) => a.destroy())]);
    }
  }
  setGlobalDispatcher(new EgressRoutingDispatcher());
  installed = true;
}

/**
 * A `lookup` for node:http/node:https that pins the request to the address
 * {@link resolveDialAddress} cleared. Literal-IP hosts never reach a lookup,
 * so callers must vet those up front, which `resolveDialAddress` does too.
 */
export function pinnedLookup(address: string): net.LookupFunction {
  const family = net.isIPv6(address) ? 6 : 4;
  return ((_hostname: string, options: { all?: boolean }, callback: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;
    if (typeof options === "object" && options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as net.LookupFunction;
}

/** Test hook: forget the cached env-derived policy. */
export function resetEgressPolicyForTests(): void {
  cachedPolicy = null;
}
