/**
 * An environment added through T3 Connect, T3 Code's account and relay
 * service. What that is, from T3 Code 0.1.11 and its relay's source:
 *
 * - **A tunnel per environment, and no relay in the path.** Linking T3
 *   Connect in T3 Code gives the environment a public address of its own,
 *   `https://prod-<16 hex>.<tunnel zone>` (`@infrawrench/git-contract`
 *   `t3-connect.ts` has the rule and where it was read). Requests go
 *   straight to it; `relay.t3.codes` only hands the address out, to the
 *   person's own devices. So there is no second credential: the forge holds
 *   the environment's own OAuth token and nothing of T3 Connect's.
 * - **Nothing here lists a person's environments.** The relay's listing
 *   (`GET /v1/environments`) takes a T3 Connect session of T3 Code's own
 *   apps (a Clerk token for its one public client, loopback redirect only).
 *   There is no sign-in a third party can send a person through, so the
 *   person pastes the address: T3 Code copies it as the MCP URL.
 * - **The sign-in is approved with the T3 Connect account.** On its tunnel
 *   address an environment sends the browser on to `app.t3.codes` to approve
 *   an outside agent, so the person needs no pairing code and no browser
 *   that is already signed in to the environment.
 * - **Its OAuth documents name its own origin** (T3 Code builds the issuer
 *   and every endpoint from the request's origin). `./oauth.ts` holds a T3
 *   Connect environment to that: an address in its documents that is
 *   anywhere else is refused, public or not.
 *
 * The check here is on top of `./http.ts`, never instead of it: the address
 * still has to be `https:` to a public host that is not this site.
 */
import { T3_CONNECT_REFUSAL, isT3ConnectHost, t3ConnectOrigin } from "@infrawrench/git-contract";
import { T3Error, publicHttpsUrl } from "./http";

/**
 * A T3 Connect environment's origin from what a person pasted, or a
 * {@link T3Error} saying why not. `siteHosts` are this site's own hosts.
 */
export const connectOrigin = (
  pasted: string,
  siteHosts: readonly string[],
  zones?: readonly string[],
): string => {
  const found = t3ConnectOrigin(pasted, zones);
  if ("problem" in found) {
    throw new T3Error(
      "address_refused",
      found.problem === "not-https"
        ? "The address has to start with https://"
        : found.problem === "empty"
          ? "That is not an address"
          : T3_CONNECT_REFUSAL,
    );
  }
  return publicHttpsUrl(found.origin, siteHosts).origin;
};

/** Whether an environment's stored origin is a T3 Connect tunnel's. */
export const isConnectOrigin = (origin: string, zones?: readonly string[]): boolean => {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.port === "" && isT3ConnectHost(url.hostname, zones);
  } catch {
    return false;
  }
};
