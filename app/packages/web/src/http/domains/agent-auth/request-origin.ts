/**
 * Where an unauthenticated agent request came from, for the per-address rate
 * limits and the verification URLs the agent ceremonies hand out. Shared by
 * agent registration (`./index.ts`) and the agent link device flow
 * (`../agent-link-platform/`).
 */
import { isIP } from "node:net";

/**
 * The client's address, for the per-IP registration limit.
 *
 * Behind our ingress (ingress-nginx with its default `use-forwarded-headers:
 * false`) the controller *overwrites* `x-forwarded-for` with the socket
 * address, so the first hop is trustworthy there. In any deployment where the
 * header passes through raw it is client-controlled, which is why the value is
 * validated as an actual IP address rather than taken as an opaque bucket key:
 * un-validated, every request could invent a fresh "address" and mint itself a
 * fresh per-IP allowance. A value that is not an IP counts as "unknown", and
 * unknown callers are governed by the global hourly ceiling instead.
 */
export function clientIp(header: string | undefined): string | null {
  const first = header?.split(",")[0]?.trim();
  if (!first) return null;
  return isIP(first) !== 0 ? first : null;
}

/** The base the verification URLs are built on: the configured one, else the request's own. */
export function publicBaseUrl(reqUrl: string, forwardedProto?: string): string {
  const fromEnv = process.env["PUBLIC_BASE_URL"] ?? process.env["APP_URL"];
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const u = new URL(reqUrl);
  const proto = forwardedProto?.split(",")[0]?.trim();
  return `${proto ? `${proto}:` : u.protocol}//${u.host}`;
}
