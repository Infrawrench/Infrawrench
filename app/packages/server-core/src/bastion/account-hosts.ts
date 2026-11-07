/**
 * The hosts an account's own credentials name, from the fields its plugin marked
 * `providerHost`. Pure, with no plugin ids: the plugin says which field holds an address
 * and this reads it.
 *
 * What comes out is safe to hand a bastion agent: it is one exact name or a public IP
 * literal per entry, never a wildcard, never a private, loopback or link-local literal,
 * never a name with no dot, which only a private resolver could answer. A name can still
 * resolve to something private, and only the agent can see that, so it checks on dial.
 */
import type { CredentialField } from "@infrawrench/plugin-base";
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

/** The allowable hosts in `credentials`, from the fields marked `providerHost`. */
export function providerHostsOf(
  fields: readonly CredentialField[],
  credentials: Readonly<Record<string, string | undefined>>,
): string[] {
  const hosts = new Set<string>();
  for (const field of fields) {
    if (!field.providerHost || field.sensitive) continue;
    for (const written of (credentials[field.key] ?? "").split(",")) {
      const host = written.trim() ? hostOf(written.trim()) : null;
      if (host) hosts.add(host);
    }
  }
  return [...hosts];
}

/** Every host this account's calls may reach through a bastion, as allowlist patterns. */
export function accountEgressHosts(
  manifest: {
    readonly egressHosts: readonly string[];
    readonly credentialFields: readonly CredentialField[];
  },
  credentials: Readonly<Record<string, string | undefined>>,
): string[] {
  return [...manifest.egressHosts, ...providerHostsOf(manifest.credentialFields, credentials)];
}
