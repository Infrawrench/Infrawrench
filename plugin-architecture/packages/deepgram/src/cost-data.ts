/**
 * Actual-spend collection from Deepgram's billing breakdown.
 *
 * `GET /v1/projects/{project_id}/billing/breakdown` reports what Deepgram
 * actually billed — a `dollars` figure in USD per time bucket per grouping —
 * so nothing here is modelled, estimated or priced off a rate card. Verified
 * against https://developers.deepgram.com/reference/manage/billing/breakdown/get
 * and Deepgram's published OpenAPI spec (deepgram/deepgram-api-specs,
 * `openapi.yml`, `BillingBreakdownV1Response`), August 2026.
 *
 * Shape of the collection:
 *
 * - One request per project. An account is a single API key, and the key's
 *   scope decides which projects `GET /v1/projects` returns, so a key that can
 *   see several projects bills for all of them. The project id rides along as
 *   a tag — the cost contract has no project dimension.
 * - `grouping` is repeated, not comma-joined (`grouping=line_item&grouping=
 *   tags`): the spec types it as a plain array with no `style`/`explode`
 *   override, which is OpenAPI's exploded form.
 * - `line_item` (e.g. `"streaming::nova-3"`) maps onto `service`. The
 *   companion `GET /v1/projects/{id}/billing/fields` returns a map of line
 *   item → human label ("Nova - 3 (Stream)"), which is prettier but is
 *   deliberately NOT used: `service` is part of the dimension key the host
 *   dedupes restatement re-fetches on, so it has to be reproducible from the
 *   breakdown response alone. A label that changed — or a `fields` call that
 *   failed on one run and succeeded on the next — would land the same money
 *   twice under two names.
 * - Deepgram's own request tags are a *list* per bucket, not key/value pairs.
 *   The bucket's dollars belong to the combination, so they are recorded as
 *   one sorted comma-joined `tags` value rather than split across the
 *   individual labels, which would multiply the money by the number of tags.
 * - `end` is over-asked by a day and rows are filtered back to the inclusive
 *   range. Deepgram does not document whether `end` is inclusive; over-asking
 *   plus a client-side filter is correct either way and keeps month chunks
 *   from dropping or double-counting their boundary day.
 *
 * Unknowns, handled defensively rather than guessed at:
 *
 * - History depth is undocumented. Days before the project existed simply come
 *   back with no results, so the manifest asks for a year and takes what it
 *   gets.
 * - Enterprise-contract accounts are not guaranteed to populate `dollars`. A
 *   missing amount is "not available", never zero — reporting a confident $0
 *   for an account that is spending money is a worse failure than reporting
 *   nothing, so a response with rows but no dollar amounts anywhere raises a
 *   {@link CostSetupError} the host shows against the account.
 */

import type { CostFetchRange, CostRow, HttpHostServices } from "@infrawrench/plugin-base";
import { CostSetupError, jsonRestFetch } from "@infrawrench/plugin-base";

const BASE_URL = "https://api.deepgram.com";

const CONSOLE_HELP = {
  label: "Open the Deepgram Console",
  url: "https://console.deepgram.com/",
};

/**
 * Everything the collector needs, without the client — the credential and the
 * two host services that make requests work from behind a bastion or through
 * a TLS-intercepting proxy.
 */
export interface DeepgramCostContext {
  /** Deepgram API key. Sent as `Authorization: Token <key>`. */
  apiKey: string;
  /** PEM trust anchor for a custom CA. Only honored together with `http`. */
  caCert?: string;
  /** Host HTTP service — bastion egress routing and custom-CA support. */
  http?: HttpHostServices;
}

interface DgProjectList {
  projects?: Array<{ project_id?: string }>;
}

interface DgBillingResult {
  /** USD billed for this grouping. Required per spec; absent in practice on some contracts. */
  dollars?: number;
  grouping?: {
    /** Bucket start, `YYYY-MM-DD`. */
    start?: string;
    end?: string;
    /** Null unless grouped by line item. e.g. "streaming::nova-3". */
    line_item?: string | null;
    /** Null unless grouped by tags. */
    tags?: string[] | null;
  };
}

interface DgBillingBreakdown {
  start?: string;
  end?: string;
  /** Bucket size Deepgram chose; `{ units: "day", amount: 1 }` for month-sized windows. */
  resolution?: { units?: string; amount?: number };
  results?: DgBillingResult[];
}

function dgFetch<T>(ctx: DeepgramCostContext, path: string): Promise<T> {
  return jsonRestFetch<T>({
    vendor: "Deepgram",
    url: `${BASE_URL}${path}`,
    errorPath: path,
    headers: { Authorization: `Token ${ctx.apiKey}`, Accept: "application/json" },
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    ...(ctx.http ? { http: ctx.http } : {}),
  });
}

/** HTTP status recovered from the message `jsonRestFetch` throws. */
function httpStatusOf(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^Deepgram API error (\d{3}) /.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * Deepgram's billing endpoints answer only to admin- and owner-scope keys; a
 * member key gets a 401/403. That is a credential the user has to replace, not
 * a transient failure, so it becomes a setup error rather than an endless
 * retry.
 */
function asScopeError(err: unknown): CostSetupError | undefined {
  const status = httpStatusOf(err);
  if (status !== 401 && status !== 403) return undefined;
  return new CostSetupError(
    "Deepgram refused the billing breakdown for this API key. Billing is readable only by " +
      "admin- and owner-scope keys — a member-scope key can transcribe and synthesize but " +
      "cannot see spend. Replace this account's key with an admin or owner key from the " +
      "project's Settings → API Keys.",
    CONSOLE_HELP,
  );
}

/** `YYYY-MM-DD` one day after `date`. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The `YYYY-MM-DD` prefix of a bucket timestamp, or "" when unusable. */
function isoDay(value: string | undefined): string {
  if (!value) return "";
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

/** Every project this key can see. One account is one key, so all of them bill. */
async function listProjectIds(ctx: DeepgramCostContext): Promise<string[]> {
  try {
    const list = await dgFetch<DgProjectList>(ctx, "/v1/projects");
    return (list.projects ?? [])
      .map((p) => p.project_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (err) {
    throw asScopeError(err) ?? err;
  }
}

export async function fetchDeepgramCostData(
  ctx: DeepgramCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const projectIds = await listProjectIds(ctx);
  if (projectIds.length === 0) return [];

  const params = new URLSearchParams({ start: range.fromDate, end: nextDay(range.toDate) });
  params.append("grouping", "line_item");
  params.append("grouping", "tags");
  const query = params.toString();

  // Keyed by the full dimension tuple (date + service + project + tags) so a
  // re-fetched day reproduces byte-identical keys and the host replaces its
  // previous rows instead of adding to them.
  const buckets = new Map<string, CostRow>();

  let sawResult = false;
  let sawDollars = false;
  let sawDatedRow = false;
  let succeeded = 0;
  let firstFailure: unknown;

  for (const projectId of projectIds) {
    const data = await dgFetch<DgBillingBreakdown>(
      ctx,
      `/v1/projects/${encodeURIComponent(projectId)}/billing/breakdown?${query}`,
    ).catch((err: unknown) => {
      // One project the key can list but not bill for shouldn't empty the
      // account; only a clean sweep of failures is worth surfacing.
      firstFailure ??= err;
      return undefined;
    });
    if (!data) continue;
    succeeded++;

    for (const result of data.results ?? []) {
      sawResult = true;
      const dollars = result.dollars;
      // Absent amount == not available. Never coerced to 0.
      if (typeof dollars !== "number" || !Number.isFinite(dollars)) continue;
      sawDollars = true;

      const date = isoDay(result.grouping?.start);
      if (!date) continue;
      sawDatedRow = true;
      if (date < range.fromDate || date > range.toDate) continue;
      if (dollars === 0) continue;

      const service = result.grouping?.line_item ?? "";
      // Sorted so the joined value doesn't depend on Deepgram's ordering.
      const tags = [...(result.grouping?.tags ?? [])].sort().join(",");

      const key = `${date}|${service}|${projectId}|${tags}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.amount += dollars;
        continue;
      }
      buckets.set(key, {
        date,
        currency: "USD",
        amount: dollars,
        ...(service ? { service } : {}),
        tags: { project: projectId, ...(tags ? { tags } : {}) },
      });
    }
  }

  if (succeeded === 0 && firstFailure !== undefined) {
    throw asScopeError(firstFailure) ?? firstFailure;
  }

  if (sawResult && !sawDollars) {
    throw new CostSetupError(
      "Deepgram returned billing activity for this account but no dollar amounts, so there " +
        "is nothing to report as spend. Accounts billed under an enterprise contract are the " +
        "usual reason — their usage is priced outside the API. Check the balance and invoices " +
        "in the Deepgram Console instead.",
      CONSOLE_HELP,
    );
  }

  if (sawDollars && !sawDatedRow) {
    throw new Error(
      "Deepgram plugin: the billing breakdown returned amounts with no bucket start date, so " +
        "the spend cannot be attributed to a day.",
    );
  }

  return [...buckets.values()].filter((row) => row.amount !== 0);
}
