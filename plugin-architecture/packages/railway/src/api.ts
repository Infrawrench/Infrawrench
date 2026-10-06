import type { HostServices } from "@infrawrench/plugin-base";
import { RailwayApiError } from "./kit.js";

/**
 * Transport for Railway's public GraphQL API
 * (`https://backboard.railway.com/graphql/v2`, schema introspected and
 * docs.railway.com/reference/public-api read 2026-10).
 *
 * Account and workspace tokens authenticate with `Authorization: Bearer`.
 * (Project tokens use a `Project-Access-Token` header instead and only see
 * one environment; this plugin does not take them.)
 *
 * GraphQL answers HTTP 200 for most failures and puts them in `errors[]`:
 * "Not Authorized" for a token that cannot see the object, "… not found"
 * for a missing id. Those are mapped onto HTTP-like statuses (403, 404, 400)
 * so the host can classify them. Rate limits are per plan and per hour
 * (Free 100, Hobby 1,000, Pro 10,000 requests an hour); a 429 carries
 * `Retry-After` and is retried once when that is short.
 */

export const GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const MAX_RETRY_S = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GraphQLError {
  message?: string;
  extensions?: { code?: string };
}

/** Map a GraphQL error onto the HTTP status the host classifies on. */
export function statusForGraphQLError(e: GraphQLError | undefined): number {
  const msg = (e?.message ?? "").toLowerCase();
  const code = (e?.extensions?.code ?? "").toUpperCase();
  if (
    code === "UNAUTHENTICATED" ||
    msg.includes("not authenticated") ||
    msg.includes("invalid token")
  ) {
    return 401;
  }
  if (code === "FORBIDDEN" || msg.includes("not authorized") || msg.includes("permission"))
    return 403;
  if (msg.includes("not found") || msg.includes("does not exist")) return 404;
  if (msg.includes("rate limit")) return 429;
  return 400;
}

export class RailwayApi {
  constructor(
    private readonly token: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  private async send(
    body: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    const http = this.services?.http;
    if (http) {
      const res = await http.request({
        url: GRAPHQL_URL,
        method: "POST",
        headers,
        body,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) h[k.toLowerCase()] = v;
      return { status: res.status, headers: h, body: res.body ?? "" };
    }
    const res = await fetch(GRAPHQL_URL, { method: "POST", headers, body });
    const h: Record<string, string> = {};
    res.headers?.forEach?.((v, k) => {
      h[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: h, body: await res.text() };
  }

  /** Run one operation; throws a RailwayApiError (with `status`) on any error. */
  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const payload = JSON.stringify({ query, variables });
    let res = await this.send(payload);
    if (res.status === 429) {
      const wait = Number(res.headers["retry-after"]);
      if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_S) {
        await sleep(wait * 1000);
        res = await this.send(payload);
      }
    }
    let parsed: { data?: T; errors?: GraphQLError[] } | undefined;
    try {
      parsed = res.body
        ? (JSON.parse(res.body) as { data?: T; errors?: GraphQLError[] })
        : undefined;
    } catch {
      parsed = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = parsed?.errors?.[0]?.message ?? res.body.slice(0, 300);
      throw new RailwayApiError(res.status, `Railway API error ${res.status}: ${msg}`);
    }
    const first = parsed?.errors?.[0];
    if (first) {
      const status = statusForGraphQLError(first);
      throw new RailwayApiError(
        status,
        `Railway API error ${status}: ${first.message ?? "unknown error"}`,
      );
    }
    if (!parsed || parsed.data === undefined || parsed.data === null) {
      throw new RailwayApiError(502, "Railway API error 502: empty response");
    }
    return parsed.data;
  }
}

/** `{edges: [{node}]}` → nodes. */
export function nodes<T>(
  conn: { edges?: Array<{ node?: T | null } | null> } | null | undefined,
): T[] {
  return (conn?.edges ?? [])
    .map((e) => e?.node)
    .filter((n): n is T => n !== null && n !== undefined);
}
