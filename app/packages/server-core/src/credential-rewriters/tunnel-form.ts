/**
 * What the SSH-tunnel rewriter changes in an account's credentials, and how: pure, and
 * kept apart from `tunnel-resolver.ts` (which opens tunnels, so the gateway only).
 *
 * A plugin marks each field that holds its service's address with `tunnel`
 * (`CredentialField.tunnel`), and nothing else is ever touched, so a token, a CA
 * certificate or a webhook URL stays as it is. Inside a marked field only the host and
 * port of an address change, located by position rather than by re-serialising the
 * value: a URL keeps its scheme, user, password, path and query byte for byte, a seed
 * list its other members, and a kubeconfig everything but the `server` of the clusters
 * that are rewritten (plus a `tls-server-name`, so the cluster's certificate is still
 * checked against the name it was issued for).
 *
 * Which addresses: the ones that name the tunnel's remote end (`remoteHost:remotePort`,
 * every loopback name counting as one host, an address without a port matching on its
 * host). When none of the account's own addresses do, the account names its service in a
 * way the tunnel config does not (a DNS name against an IP, say), and the first address
 * of each marked field is rewritten instead: for a kubeconfig, the cluster of its current
 * context. A peer plugin's credentials (a managed database's connection string resolved
 * from a cloud account) get no such fallback, since the tunnel was set up for something
 * else of the account's; only an address naming the tunnel's remote end is theirs.
 *
 * An address already at the local end counts as naming the tunnel and is left alone, so
 * rewriting twice is the same as rewriting once.
 */
import type { CredentialField } from "@infrawrench/plugin-base";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

export type TunnelForm = NonNullable<CredentialField["tunnel"]>;

/** An open tunnel's two ends, as the rewriter needs them. */
export interface TunnelEnds {
  /** The local end, on 127.0.0.1. */
  localPort: number;
  /** What the bastion forwards to, as the account's tunnel config names it. */
  remoteHost: string;
  remotePort: number;
}

/** Replace `[at, end)` of a value with `text`. */
interface Edit {
  at: number;
  end: number;
  text: string;
}

/** One address written in a credential value. */
interface Address {
  /** Lowercase, without IPv6 brackets or a trailing dot. */
  host: string;
  /** Null when the address leaves it to the scheme's default. */
  port: number | null;
  /** What pointing this address at `127.0.0.1:<localPort>` changes in the value. */
  edits(localPort: number): Edit[];
}

/** The addresses in a value, and the one a client dials first. */
interface Addresses {
  list: Address[];
  primary: Address | undefined;
}

const LOCAL_HOST = "127.0.0.1";

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const REG_NAME = /^[A-Za-z0-9_~%-]+(\.[A-Za-z0-9_~%-]+)*\.?$/;
const IPV6 = /^\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(%[A-Za-z0-9._~%-]+)?\]$/;

/** Where a `host[:port]` sits in a value, and what it says. */
interface HostPort {
  host: string;
  port: number | null;
  at: number;
  end: number;
}

/** `text` as a `host[:port]` written at `offset`, or null when it is not one. */
function hostPortAt(text: string, offset: number): HostPort | null {
  let host: string;
  let portText: string | undefined;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return null;
    host = text.slice(0, close + 1);
    const rest = text.slice(close + 1);
    if (!IPV6.test(host) || (rest !== "" && !/^:\d{1,5}$/.test(rest))) return null;
    portText = rest ? rest.slice(1) : undefined;
  } else {
    const colon = text.lastIndexOf(":");
    host = colon === -1 ? text : text.slice(0, colon);
    portText = colon === -1 ? undefined : text.slice(colon + 1);
    if (!REG_NAME.test(host) || (portText !== undefined && !/^\d{1,5}$/.test(portText))) {
      return null;
    }
  }
  const port = portText === undefined ? null : Number(portText);
  if (port !== null && port > 65535) return null;
  return { host: normaliseHost(host), port, at: offset, end: offset + text.length };
}

function normaliseHost(host: string): string {
  return host
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

/** An address whose rewrite is replacing its `host[:port]`. */
function addressAt(found: HostPort): Address {
  return {
    host: found.host,
    port: found.port,
    edits: (localPort) => [{ at: found.at, end: found.end, text: `${LOCAL_HOST}:${localPort}` }],
  };
}

/**
 * A URL's hosts, every one of a multi-host authority (`postgresql://a:5432,b:5432/db`,
 * a MongoDB seed list), read by position so nothing else of it is parsed or changed.
 * Null when `text` is not a URL with at least one host.
 */
function urlHosts(text: string, offset: number): Address[] | null {
  const scheme = SCHEME.exec(text);
  // A `+srv` scheme names a DNS SRV record, not a host to dial, and takes no port.
  if (!scheme || /\+srv:\/\/$/i.test(scheme[0])) return null;
  const tail = text.slice(scheme[0].length);
  const stop = tail.search(/[/?#]/);
  const authority = stop === -1 ? tail : tail.slice(0, stop);
  // The user and password end at the last `@`, which neither a host nor a port has.
  const hostsStart = authority.lastIndexOf("@") + 1;
  const hostsText = authority.slice(hostsStart);
  if (!hostsText) return null;
  const list: Address[] = [];
  let cursor = offset + scheme[0].length + hostsStart;
  for (const part of hostsText.split(",")) {
    const found = hostPortAt(part, cursor);
    if (!found) return null;
    list.push(addressAt(found));
    cursor += part.length + 1;
  }
  return list;
}

/** A list entry: a URL, or `[userinfo@]host[:port]`, spaces around it allowed. */
function entryAddresses(entry: string, offset: number): Address[] | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const start = offset + entry.length - entry.trimStart().length;
  const asUrl = urlHosts(trimmed, start);
  if (asUrl) return asUrl;
  const userinfoEnd = trimmed.lastIndexOf("@") + 1;
  const found = hostPortAt(trimmed.slice(userinfoEnd), start + userinfoEnd);
  return found ? [addressAt(found)] : null;
}

/**
 * The addresses of an `address` field: one URL (several hosts in its authority allowed),
 * or a comma-separated list of URLs and `host[:port]`s. Null for anything else.
 */
function addressesOf(value: string): Addresses | null {
  if (/[\r\n]/.test(value)) return null;
  // Whole first: a URL with several hosts has commas in its authority. One whose
  // authority only looks like that (`nats://a:4222,nats://b:4222`) fails and is a list.
  let list = entryAddresses(value, 0);
  if (!list) {
    list = [];
    let cursor = 0;
    for (const entry of value.split(",")) {
      const found = entryAddresses(entry, cursor);
      if (!found) return null;
      list.push(...found);
      cursor += entry.length + 1;
    }
  }
  return list.length > 0 ? { list, primary: list[0] } : null;
}

/**
 * The clusters of a kubeconfig, each one address: its `server` URL, located in the
 * source so the rest of the file is left as written. A cluster that goes through a
 * `proxy-url` is not one, since the proxy, not this host, dials the server. Null when the
 * value is not a kubeconfig.
 */
function kubeconfigAddresses(value: string): Addresses | null {
  const doc = parseDocument(value);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const root = doc.contents;
  const clusters = root.get("clusters", true);
  if (!isSeq(clusters)) return null;

  const byName = new Map<string, Address>();
  const list: Address[] = [];
  for (const item of clusters.items) {
    if (!isMap(item)) continue;
    const cluster = item.get("cluster", true);
    if (!isMap(cluster) || cluster.get("proxy-url")) continue;
    const address = clusterAddress(value, cluster);
    if (!address) continue;
    list.push(address);
    const name = item.get("name");
    if (typeof name === "string") byName.set(name, address);
  }
  if (list.length === 0) return null;

  // The cluster the client uses: the current context's, or the only one there is.
  let primary: Address | undefined;
  const current = root.get("current-context");
  const contexts = root.get("contexts", true);
  if (typeof current === "string" && isSeq(contexts)) {
    for (const item of contexts.items) {
      if (!isMap(item) || item.get("name") !== current) continue;
      const context = item.get("context", true);
      const clusterName = isMap(context) ? context.get("cluster") : undefined;
      if (typeof clusterName === "string") primary = byName.get(clusterName);
    }
  }
  return { list, primary: primary ?? (list.length === 1 ? list[0] : undefined) };
}

/** A cluster's `server` as an address, or null when it is not a URL with one host. */
function clusterAddress(source: string, cluster: YAMLMap): Address | null {
  const pair = cluster.items.find((p) => isScalar(p.key) && p.key.value === "server");
  const key = pair?.key;
  const server = pair?.value;
  if (!isScalar(key) || !isScalar(server) || typeof server.value !== "string") return null;
  if (!key.range || !server.range) return null;
  // A block scalar's header and indentation are not worth splicing around.
  if (server.type !== "PLAIN" && server.type !== "QUOTE_DOUBLE" && server.type !== "QUOTE_SINGLE") {
    return null;
  }
  const text = server.value;
  const hosts = urlHosts(text, 0);
  if (!hosts || hosts.length !== 1) return null;
  const [url] = hosts as [Address];
  const [start, valueEnd] = server.range;
  const quote = server.type === "QUOTE_DOUBLE" ? '"' : server.type === "QUOTE_SINGLE" ? "'" : "";
  // Written exactly as it reads (no escapes, not folded over lines): splice in the host
  // alone. Otherwise the whole scalar becomes one double-quoted string, valid anywhere.
  const verbatim = source.slice(start, valueEnd) === `${quote}${text}${quote}`;
  const keyStart = key.range[0];

  return {
    host: url.host,
    port: url.port,
    edits(localPort) {
      const [inner] = url.edits(localPort) as [Edit];
      const edits: Edit[] = [
        verbatim
          ? {
              at: start + quote.length + inner.at,
              end: start + quote.length + inner.end,
              text: inner.text,
            }
          : {
              at: start,
              end: valueEnd,
              text: JSON.stringify(text.slice(0, inner.at) + inner.text + text.slice(inner.end)),
            },
      ];
      const serverName = tlsServerNameEdit(source, cluster, keyStart, valueEnd, url.host);
      if (serverName) edits.push(serverName);
      return edits;
    },
  };
}

/**
 * Adds `tls-server-name: <original host>` beside a rewritten `server`, so the client
 * still checks the certificate against the name it was issued for rather than against
 * 127.0.0.1. Nothing when the cluster already names one or skips verification.
 */
function tlsServerNameEdit(
  source: string,
  cluster: YAMLMap,
  keyStart: number,
  valueEnd: number,
  host: string,
): Edit | null {
  if (cluster.has("tls-server-name")) return null;
  const skip = cluster.get("insecure-skip-tls-verify");
  if (skip === true || skip === "true") return null;
  if (cluster.flow) {
    return { at: valueEnd, end: valueEnd, text: `, "tls-server-name": ${JSON.stringify(host)}` };
  }
  const name = /^[a-z0-9._-]+$/.test(host) ? host : JSON.stringify(host);
  // A new line under `server`, at its indentation: the column of its key.
  const indent = " ".repeat(keyStart - (source.lastIndexOf("\n", keyStart - 1) + 1));
  let lineEnd = source.indexOf("\n", valueEnd);
  if (lineEnd === -1) lineEnd = source.length;
  const crlf = lineEnd > 0 && source[lineEnd - 1] === "\r";
  const at = crlf ? lineEnd - 1 : lineEnd;
  return { at, end: at, text: `${crlf ? "\r\n" : "\n"}${indent}tls-server-name: ${name}` };
}

function addressesIn(form: TunnelForm, value: string): Addresses | null {
  return form === "kubeconfig" ? kubeconfigAddresses(value) : addressesOf(value);
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  );
}

function sameHost(a: string, b: string): boolean {
  const x = normaliseHost(a);
  const y = normaliseHost(b);
  return x === y || (isLoopback(x) && isLoopback(y));
}

function atLocalEnd(address: Address, tunnel: TunnelEnds): boolean {
  return address.port === tunnel.localPort && isLoopback(address.host);
}

function atRemoteEnd(address: Address, tunnel: TunnelEnds): boolean {
  return (
    sameHost(address.host, tunnel.remoteHost) &&
    (address.port === null || address.port === tunnel.remotePort)
  );
}

function applyEdits(value: string, edits: readonly Edit[]): string {
  let out = value;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** One value to rewrite: the form its field declares, and what it holds. */
interface TunnelTarget {
  form: TunnelForm;
  value: string;
}

/**
 * Each target's value pointed at the tunnel, in order. `fallback` is for an account's
 * own credentials: when none of the targets names the tunnel's remote end, rewrite each
 * one's primary address instead.
 */
function rewriteTargets(
  targets: readonly TunnelTarget[],
  tunnel: TunnelEnds,
  { fallback }: { fallback: boolean },
): string[] {
  const found = targets.map((t) => addressesIn(t.form, t.value));
  const named = found.some((a) =>
    a?.list.some((x) => atLocalEnd(x, tunnel) || atRemoteEnd(x, tunnel)),
  );
  return targets.map((target, i) => {
    const addresses = found[i];
    if (!addresses) return target.value;
    const chosen = named
      ? addresses.list.filter((a) => atRemoteEnd(a, tunnel) && !atLocalEnd(a, tunnel))
      : fallback && addresses.primary
        ? [addresses.primary]
        : [];
    if (chosen.length === 0) return target.value;
    return applyEdits(
      target.value,
      chosen.flatMap((a) => a.edits(tunnel.localPort)),
    );
  });
}

/** One value pointed at the tunnel, the way a field marked `tunnel: form` is. */
export function rewriteValueThroughTunnel(
  form: TunnelForm,
  value: string,
  tunnel: TunnelEnds,
  options: { fallback: boolean },
): string {
  return rewriteTargets([{ form, value }], tunnel, options)[0]!;
}

/**
 * Points the credentials of the fields marked `tunnel` at the tunnel, in place. Returns
 * the keys it changed.
 */
export function rewriteCredentialFields(
  fields: readonly CredentialField[],
  credentials: Record<string, string>,
  tunnel: TunnelEnds,
  options: { fallback: boolean },
): string[] {
  const marked = fields.filter(
    (f): f is CredentialField & { tunnel: TunnelForm } =>
      f.tunnel !== undefined && typeof credentials[f.key] === "string",
  );
  const rewritten = rewriteTargets(
    marked.map((f) => ({ form: f.tunnel, value: credentials[f.key]! })),
    tunnel,
    options,
  );
  const changed: string[] = [];
  marked.forEach((f, i) => {
    if (rewritten[i] !== credentials[f.key]) {
      credentials[f.key] = rewritten[i]!;
      changed.push(f.key);
    }
  });
  return changed;
}
