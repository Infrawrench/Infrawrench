import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import type { NewRelicRegion } from "./regions.js";

/**
 * Everything a NerdGraph request needs. Split out of the client so the cost
 * collector, the credential-option loader and the tests can run without one.
 */
export interface NewRelicContext {
  apiKey: string;
  region: NewRelicRegion;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for a non-2xx answer or a GraphQL error, carrying what callers branch on. */
export class NewRelicApiError extends Error {
  readonly status: number;
  /** `extensions.errorClass` of the first GraphQL error, e.g. `FORBIDDEN`. */
  readonly errorClass: string;
  constructor(status: number, message: string, errorClass = "") {
    super(message);
    this.name = "NewRelicApiError";
    this.status = status;
    this.errorClass = errorClass;
  }
}

interface GraphQlError {
  message?: string;
  path?: Array<string | number>;
  extensions?: { errorClass?: string; code?: string };
}

const STATUS_IN_MESSAGE = /New Relic API error (\d{3})/;

/**
 * POST a query or mutation to the region's NerdGraph endpoint. NerdGraph
 * authenticates with the `API-Key` header and a User key (`NRAK-…`), which
 * carries the permissions of the user it belongs to.
 *
 * NerdGraph answers most failures with HTTP 200 and an `errors` array. With
 * `allowPartial`, errors that came back alongside data (one inaccessible
 * account in a multi-account query, say) are tolerated and the data returned;
 * otherwise any error throws.
 *
 * Routed through the host HTTP service whenever there is one: that is the
 * only path that honours bastion egress and a custom CA.
 */
export async function nerdgraph<T>(
  ctx: NewRelicContext,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { allowPartial?: boolean } = {},
): Promise<T> {
  let res: { data?: T | null; errors?: GraphQlError[] };
  try {
    res = await jsonRestFetch<{ data?: T | null; errors?: GraphQlError[] }>({
      vendor: "New Relic",
      url: ctx.region.graphqlUrl,
      errorPath: "/graphql",
      headers: { Accept: "application/json", "API-Key": ctx.apiKey },
      init: { method: "POST", body: JSON.stringify({ query, variables }) },
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new NewRelicApiError(status, message);
    throw err;
  }
  const errors = res?.errors ?? [];
  if (errors.length > 0 && !(opts.allowPartial && res?.data)) {
    const first = errors[0]!;
    const errorClass = first.extensions?.errorClass ?? first.extensions?.code ?? "";
    const status =
      errorClass === "FORBIDDEN" || errorClass === "UNAUTHORIZED" || errorClass === "ACCESS_DENIED"
        ? 403
        : 0;
    throw new NewRelicApiError(
      status,
      `New Relic API error: ${errors.map((e) => e.message ?? "unknown error").join("; ")}`,
      errorClass,
    );
  }
  if (!res?.data) throw new NewRelicApiError(0, "New Relic API error: empty response");
  return res.data;
}

/** HTTP-ish status of a failed call (403 for a GraphQL permission error), or 0. */
export function statusOf(err: unknown): number {
  return err instanceof NewRelicApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/** One NRQL result row: aliases and facet attributes as keys. */
export type NrqlRow = Record<string, unknown>;

/**
 * Run NRQL in one account. NRQL strings are inlined as a GraphQL variable of
 * type `Nrql!`, never concatenated into the GraphQL document. The timeout is
 * NerdGraph's own (seconds, at most 120); usage queries over a whole month
 * can take a while.
 */
export async function runNrql(
  ctx: NewRelicContext,
  accountId: number,
  nrql: string,
  timeoutSeconds = 60,
): Promise<NrqlRow[]> {
  const data = await nerdgraph<{
    actor?: { account?: { nrql?: { results?: NrqlRow[] | null } | null } | null };
  }>(
    ctx,
    `query($accountId: Int!, $nrql: Nrql!, $timeout: Seconds) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: $timeout) { results } } }
}`,
    { accountId, nrql, timeout: timeoutSeconds },
  );
  return data.actor?.account?.nrql?.results ?? [];
}

/** A string literal safe to splice into NRQL (single quotes, escaped). */
export function nrqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export interface NewRelicAccount {
  id: number;
  name: string;
}

/** Every account the key can see, in the key's region. */
export async function listAccounts(ctx: NewRelicContext): Promise<NewRelicAccount[]> {
  const data = await nerdgraph<{
    actor?: { accounts?: Array<{ id?: number; name?: string }> | null };
  }>(ctx, `{ actor { accounts { id name } } }`);
  return (data.actor?.accounts ?? [])
    .filter((a): a is { id: number; name?: string } => typeof a.id === "number")
    .map((a) => ({ id: a.id, name: a.name ?? String(a.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
