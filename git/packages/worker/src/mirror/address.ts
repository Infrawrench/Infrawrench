/**
 * Where a push mirror may push: a public `https` address of a Git
 * repository, with nothing in it but a host and a path.
 *
 * The same guard the image proxy has (`images/proxy.ts` `blockedHost`),
 * checked when a mirror is saved and again before every run: no private,
 * loopback, link-local or reserved address, no name only a local network
 * resolves, and never this site. A credential is never part of the address
 * (it is stored sealed, beside it), so the address can be shown and stored
 * as it is, and a redirect is never followed (`@infrawrench/git-protocol`
 * `send-pack`), so the host that is checked is the host that is reached.
 */
import { blockedHost } from "../images/proxy";

export const MAX_MIRROR_URL_LENGTH = 500;

export type MirrorAddress =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly problem: string };

export interface MirrorAddressOptions {
  /** This site's hosts: never a target. */
  readonly siteHosts: readonly string[];
  /**
   * Tests only: also take `http:` and loopback, to push to a Git host on
   * this machine. Nothing in the Worker sets it.
   */
  readonly allowLocal?: boolean;
}

/** `value` as a mirror's address, tidied, or why it cannot be one. */
export const mirrorAddress = (value: string, options: MirrorAddressOptions): MirrorAddress => {
  const refuse = (problem: string): MirrorAddress => ({ ok: false, problem });
  const text = value.trim();
  if (text === "" || text.length > MAX_MIRROR_URL_LENGTH) {
    return refuse("Enter the repository's HTTPS address");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse("That is not an address");
  }
  if (url.protocol !== "https:" && !(options.allowLocal && url.protocol === "http:")) {
    return refuse("A mirror pushes over HTTPS: the address starts with https://");
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("Leave the user and the token out of the address: they go in the fields below");
  }
  if (url.search !== "" || url.hash !== "") {
    return refuse("The address cannot have a query or a fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") return refuse("The address needs the repository's path");
  const host = url.hostname.toLowerCase();
  if (!options.allowLocal && blockedHost(host)) {
    return refuse("A mirror pushes to a public address");
  }
  if (options.siteHosts.some((site) => site.toLowerCase() === host)) {
    return refuse("A mirror pushes to another host, not to this one");
  }
  return { ok: true, url: `${url.protocol}//${url.host}${path}`, host };
};

/** The Basic auth user a credential goes with when none is given: what GitHub takes for any token. */
export const DEFAULT_MIRROR_USERNAME = "x-access-token";

/** The `Authorization` value of a mirror's requests. */
export const basicAuthorization = (username: string, credential: string): string => {
  const bytes = new TextEncoder().encode(`${username}:${credential}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
};
