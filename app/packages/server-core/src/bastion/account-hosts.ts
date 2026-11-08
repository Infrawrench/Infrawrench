/**
 * The hosts an account's own credentials name, from the fields its plugin marked
 * `providerHost`. Pure, with no plugin ids: the plugin says which field holds an address
 * and this reads it.
 *
 * What comes out is safe to hand a bastion agent: it is one exact name or a public IP
 * literal per entry, never a private, loopback or link-local literal, never a name with
 * no dot, which only a private resolver could answer. The one wildcard is `*.<host>` for
 * a field also marked `providerHostSubdomains`, and only on a DNS name of three labels or
 * more, so an address, `example.com` or `co.uk` never becomes one; the dispatcher and the
 * agent match it as exactly one extra label. A name can still resolve to something
 * private, and only the agent can see that, so it checks on every dial.
 */
import type { CredentialField } from "@infrawrench/plugin-base";
import { PUBLIC_ONLY_PREFIX } from "./protocol.js";
import { isPublicAddress, looksLikeIpAddress } from "./public-address.js";

const DNS_NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+\.?$/;

/** One URL, bare host or `host:port` to its host, or null if that is not a host we can allow. */
function hostOf(written: string): string | null {
  // Parsed as https whatever the scheme, so a `nats://` or a bare `host:port` gets the same
  // reading of decimal and hex IPv4 spellings as the https request that would follow.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(written);
  if (scheme && scheme[1]?.toLowerCase() === "unix") return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${written.slice(scheme?.[0].length ?? 0)}`).hostname;
  } catch {
    return null;
  }
  const host = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (looksLikeIpAddress(host)) return isPublicAddress(host) ? host : null;
  if (!DNS_NAME.test(host) || host.endsWith(".localhost") || host === "localhost") return null;
  return host;
}

/** The names one label under `host`, as an entry, or null when `host` must stay exact. */
function subdomainsOf(host: string): string | null {
  if (looksLikeIpAddress(host)) return null;
  return host.replace(/\.$/, "").split(".").length >= 3 ? `*.${host}` : null;
}

/**
 * The allowable hosts in `credentials`, from the fields marked `providerHost`, plus
 * `*.<host>` for a field also marked `providerHostSubdomains`.
 */
export function providerHostsOf(
  fields: readonly CredentialField[],
  credentials: Readonly<Record<string, string | undefined>>,
): string[] {
  const hosts = new Set<string>();
  for (const field of fields) {
    if (!field.providerHost || field.sensitive) continue;
    for (const written of (credentials[field.key] ?? "").split(",")) {
      const host = written.trim() ? hostOf(written.trim()) : null;
      if (!host) continue;
      hosts.add(host);
      const subdomains = field.providerHostSubdomains ? subdomainsOf(host) : null;
      if (subdomains) hosts.add(subdomains);
    }
  }
  return [...hosts];
}

/**
 * Every host this account's calls may reach through a bastion, as allowlist patterns: the
 * account's own under `public:`, as the agent gets them, so `hostMatches` reads a
 * `*.<host>` of its own as one label deep rather than as a manifest wildcard.
 */
export function accountEgressHosts(
  manifest: {
    readonly egressHosts: readonly string[];
    readonly credentialFields: readonly CredentialField[];
  },
  credentials: Readonly<Record<string, string | undefined>>,
): string[] {
  return [
    ...manifest.egressHosts,
    ...providerHostsOf(manifest.credentialFields, credentials).map(
      (host) => `${PUBLIC_ONLY_PREFIX}${host}`,
    ),
  ];
}
