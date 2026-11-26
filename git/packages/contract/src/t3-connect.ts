/**
 * What a T3 Connect address is, as one rule the worker, the UI and the mock
 * share. Read from T3 Code's relay source (`infra/relay/src/deploymentConfig.ts`,
 * `managedEndpointHostname`) and its README, not guessed:
 *
 * - T3 Connect gives each linked environment a Cloudflare tunnel of its own
 *   at `https://<stage>-<digest>.<tunnel zone>/`. The relay (`relay.t3.codes`)
 *   hands that address out and is not in the path of a request.
 * - `<stage>` is `prod` for every released build, stable and nightly.
 *   `<digest>` is the first 16 hex characters of a SHA-256 over the stage,
 *   the person's T3 Connect user id and the environment's id, so it cannot be
 *   worked out from an environment id alone.
 * - The tunnel zone is a deployment variable of T3 Code's
 *   (`RELAY_TUNNEL_ZONE_NAME`). Neither the source nor the documentation says
 *   what it is in production, so {@link T3_CONNECT_ZONES} starts empty and
 *   the label is what is checked. Name the zone there once it has been read
 *   off a real address and the rule becomes exact.
 *
 * An environment's MCP server is at `<address>/mcp`, which is what T3 Code's
 * "Copy MCP URL" copies, so that is what a person pastes.
 */

/** A managed endpoint's first label: the production stage, then the digest. */
const ENDPOINT_LABEL = /^prod-[0-9a-f]{16}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The zones T3 Connect's production tunnels are under, without a leading
 * dot. Empty: any public zone, with the label still checked.
 */
export const T3_CONNECT_ZONES: readonly string[] = [];

/** Whether `hostname` is a T3 Connect tunnel's: `prod-<16 hex>.<zone>`. */
export const isT3ConnectHost = (
  hostname: string,
  zones: readonly string[] = T3_CONNECT_ZONES,
): boolean => {
  const host = hostname.toLowerCase();
  const [first, ...zone] = host.split(".");
  if (first === undefined || !ENDPOINT_LABEL.test(first)) return false;
  // A zone is a name somebody registered: two labels at least.
  if (zone.length < 2 || !zone.every((label) => DNS_LABEL.test(label))) return false;
  if (host.length > 253) return false;
  return zones.length === 0 || zones.some((each) => each.toLowerCase() === zone.join("."));
};

export type T3ConnectProblem = "empty" | "not-https" | "not-t3-connect";

/**
 * A T3 Connect environment's origin from what a person pasted (the MCP URL,
 * the address, or the host alone), or what is wrong with it. `https:`, the
 * default port, no user name or password, and a host {@link isT3ConnectHost}
 * takes. The path is dropped: `/mcp` is put back by the client.
 */
export const t3ConnectOrigin = (
  pasted: string,
  zones: readonly string[] = T3_CONNECT_ZONES,
): { readonly origin: string } | { readonly problem: T3ConnectProblem } => {
  const value = pasted.trim();
  if (value === "") return { problem: "empty" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { problem: "empty" };
  }
  if (url.protocol !== "https:") {
    return { problem: url.protocol === "http:" ? "not-https" : "not-t3-connect" };
  }
  if (url.port !== "" || url.username !== "" || url.password !== "") {
    return { problem: "not-t3-connect" };
  }
  if (!isT3ConnectHost(url.hostname, zones)) return { problem: "not-t3-connect" };
  return { origin: url.origin };
};

/** Whether a stored environment address (`https://host`) is a T3 Connect one. */
export const isT3ConnectAddress = (
  baseUrl: string,
  zones: readonly string[] = T3_CONNECT_ZONES,
): boolean => {
  const found = t3ConnectOrigin(baseUrl, zones);
  return "origin" in found && found.origin === baseUrl.replace(/\/+$/, "");
};

/** What to say when a pasted value is not a T3 Connect address. Shown by the API and the form alike. */
export const T3_CONNECT_REFUSAL =
  "That is not a T3 Connect address. In T3 Code, turn T3 Connect on, then use Copy MCP URL on the environment in Settings, Environments.";
