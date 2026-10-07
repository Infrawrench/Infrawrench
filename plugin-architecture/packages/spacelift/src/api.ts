import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Spacelift GraphQL API (https://docs.spacelift.io/integrations/api,
 * request shapes from spacelift-io/spacelift-api-bruno, field names from
 * spacelift-io/terraform-provider-spacelift `internal/structs` and
 * spacelift-io/spacectl, verified 2026-10).
 *
 * - One endpoint per account: `https://<account>.app.spacelift.io/graphql`
 *   (`.app.us.spacelift.io` for the US region, or a self-hosted host).
 * - Every call is `Authorization: Bearer <jwt>`. The JWT comes from
 *   exchanging a secret-based API key: `mutation { apiKeyUser(id, secret) { jwt } }`
 *   (no auth on that call). It expires (the `exp` claim, about an hour), so
 *   the client caches it and re-exchanges near expiry or on an
 *   unauthorized answer.
 * - GraphQL reports most failures as HTTP 200 with an `errors` array; those
 *   are mapped to a {@link SpaceliftApiError} with a best-guess HTTP status
 *   so the poller can classify them.
 */
export interface SlContext {
  endpoint: string;
  keyId: string;
  keySecret: string;
  http?: HttpHostServices;
  caCert?: string;
  /** Cached JWT and its expiry (ms). */
  jwt?: { token: string; expiresAt: number };
}

export class SpaceliftApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SpaceliftApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof SpaceliftApiError ? err.status : 0;
}

/**
 * What the user typed (an account name, a hostname or the full GraphQL URL)
 * into the GraphQL endpoint URL.
 */
export function normaliseEndpoint(raw: string | undefined): string {
  let v = (raw ?? "").trim().toLowerCase();
  if (!v) throw new Error("Spacelift plugin: enter your account name or GraphQL endpoint");
  v = v
    .replace(/^https?:\/\//, "")
    .replace(/\/graphql\/?$/, "")
    .replace(/\/+$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(v)) v = `${v}.app.spacelift.io`;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(v)) {
    throw new Error(`Spacelift plugin: "${raw}" is not an account name or hostname`);
  }
  return `https://${v}/graphql`;
}

/** `https://acme.app.spacelift.io/graphql` → `https://acme.app.spacelift.io`. */
export function webBase(endpoint: string): string {
  return endpoint.replace(/\/graphql$/, "");
}

/** The account subdomain, for display. */
export function accountName(endpoint: string): string {
  return new URL(endpoint).host.split(".")[0] ?? "";
}

function jwtExpiry(jwt: string): number {
  try {
    const part = jwt.split(".")[1] ?? "";
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch {
    // opaque token: assume the documented hour
  }
  return Date.now() + 50 * 60 * 1000;
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

/** Map GraphQL error messages to an HTTP-like status. */
export function statusForErrors(
  errors: Array<{ message?: string; extensions?: { code?: string } }>,
): number {
  const text = errors
    .map((e) => `${e.extensions?.code ?? ""} ${e.message ?? ""}`)
    .join(" ")
    .toLowerCase();
  if (/unauthori[sz]ed|unauthenticated|invalid token|jwt/.test(text)) return 401;
  if (/forbidden|permission|not allowed|access denied/.test(text)) return 403;
  if (/not found|does not exist|could not find/.test(text)) return 404;
  if (/rate limit|too many/.test(text)) return 429;
  return 400;
}

async function post(
  ctx: SlContext,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
  const payload = JSON.stringify(body);
  if (ctx.http) {
    const res = await ctx.http.request({
      url: ctx.endpoint,
      method: "POST",
      headers,
      body: payload,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, text: res.body };
  }
  const res = await fetch(ctx.endpoint, { method: "POST", headers, body: payload });
  return { status: res.status, text: await res.text() };
}

function parse<T>(status: number, text: string, what: string): T {
  if (status < 200 || status >= 300) {
    throw new SpaceliftApiError(
      status,
      `Spacelift API error ${status} for ${what}: ${text.slice(0, 500)}`,
    );
  }
  let res: GqlResponse<T>;
  try {
    res = JSON.parse(text) as GqlResponse<T>;
  } catch {
    throw new SpaceliftApiError(502, `Spacelift API returned a non-JSON answer for ${what}`);
  }
  if (res.errors && res.errors.length > 0) {
    throw new SpaceliftApiError(
      statusForErrors(res.errors),
      `Spacelift API error for ${what}: ${res.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return res.data as T;
}

/** Exchange the API key for a JWT (cached until a minute before it expires). */
export async function token(ctx: SlContext, force = false): Promise<string> {
  if (!force && ctx.jwt && ctx.jwt.expiresAt - 60_000 > Date.now()) return ctx.jwt.token;
  const { status, text } = await post(ctx, {
    query:
      "mutation GetSpaceliftToken($id: ID!, $secret: String!) { apiKeyUser(id: $id, secret: $secret) { jwt } }",
    variables: { id: ctx.keyId, secret: ctx.keySecret },
  });
  const data = parse<{ apiKeyUser?: { jwt?: string } | null }>(status, text, "apiKeyUser");
  const jwt = data?.apiKeyUser?.jwt;
  if (!jwt) {
    throw new SpaceliftApiError(
      401,
      "Spacelift rejected the API key: check the key ID and secret, and that the key is a secret-based key.",
    );
  }
  ctx.jwt = { token: jwt, expiresAt: jwtExpiry(jwt) };
  return jwt;
}

/**
 * One GraphQL operation. `name` labels errors. Re-exchanges the key once
 * when the JWT is refused.
 */
export async function gql<T>(
  ctx: SlContext,
  name: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let bearer = await token(ctx);
  let res = await post(ctx, { query, variables }, bearer);
  const unauthorized =
    res.status === 401 ||
    (res.status === 200 &&
      /"errors"/.test(res.text) &&
      /unauthori[sz]ed|unauthenticated/i.test(res.text));
  if (unauthorized) {
    bearer = await token(ctx, true);
    res = await post(ctx, { query, variables }, bearer);
  }
  return parse<T>(res.status, res.text, name);
}

/** Strip ANSI colour codes from run log lines. */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
