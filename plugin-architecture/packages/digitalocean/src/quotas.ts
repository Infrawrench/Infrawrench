/**
 * DigitalOcean quota readings — the account's own limits, counted against the
 * pagination envelope.
 *
 * `GET /v2/account` reports the ceilings; nothing reports the usage, so it is
 * counted with `?per_page=1` reads whose `meta.total` is the whole answer.
 * Three requests for two quotas, which is cheap enough to run on the same
 * cadence as everything else.
 *
 * **Wire shape verified against DigitalOcean's published OpenAPI document,
 * August 2026** (`specification/resources/account/models/account.yml` in
 * github.com/digitalocean/openapi). Two corrections to what a reasonable
 * person would assume, both of which would have produced silently missing
 * rows:
 *
 * - **There is no `volume_limit`.** Block storage has no account limit in the
 *   API at all, so this module reports no volume quota. Reporting one from the
 *   documented default would be exactly the invented limit the contract
 *   forbids.
 * - **There is no `reserved_ip_limit`.** DigitalOcean renamed floating IPs to
 *   reserved IPs and did *not* rename the field: the limit on reserved IPs is
 *   still `floating_ip_limit`, and its own description in the spec requires
 *   the `reserved_ip:read` token scope while keeping the old name. Reading a
 *   `reserved_ip_limit` that does not exist yields `undefined`, which is the
 *   quota quietly vanishing rather than an error anybody would notice.
 *
 * The counts come from `/v2/reserved_ips` rather than `/v2/floating_ips`:
 * both paths still exist and address the same objects, and the reserved name
 * is the current product. `meta.total` is the total across pages, not the page
 * size, which is what makes `per_page=1` a counter rather than a full listing.
 */

import { QuotaAccessError, type QuotaUsage } from "@infrawrench/plugin-base";

/** The subset of `GET /v2/account` this module decodes. */
export interface DoAccountResponse {
  account?: {
    droplet_limit?: number;
    /** Reserved IPs, under the pre-rename field name. See the module header. */
    floating_ip_limit?: number;
    status?: string;
    team?: { uuid?: string; name?: string };
  };
}

/** The `meta` envelope every DO list endpoint carries. */
export interface DoListMeta {
  meta?: { total?: number };
}

/** The client's private `fetch`, bound and passed in (the `DoCostFetchContext` shape). */
export interface DoQuotaContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
}

const DOCS_URL = "https://docs.digitalocean.com/support/why-am-i-receiving-a-limit-error/";

/**
 * Count the objects behind a list endpoint without listing them.
 *
 * Returns null rather than zero when the envelope is missing its total: an
 * endpoint the token cannot read returns an error (which propagates), but a
 * response whose shape we do not recognise is a fact we do not have, and
 * storing it as zero would draw an empty bar under a limit that may well be
 * full.
 */
export async function countDoObjects(ctx: DoQuotaContext, path: string): Promise<number | null> {
  const response = await ctx.fetch<DoListMeta>(`${path}?per_page=1`);
  const total = response.meta?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/**
 * Read the account's quotas.
 *
 * Both readings are assembled from a limit and a count, and a quota is emitted
 * only when both halves are present. A limit with no count would render as 0%
 * used, which is a claim; omitting the row is not.
 */
export async function fetchDoQuotas(ctx: DoQuotaContext): Promise<QuotaUsage[]> {
  const response = await ctx.fetch<DoAccountResponse>("/account");
  const account = response.account;
  if (!account) {
    throw new QuotaAccessError(
      "DigitalOcean's /v2/account returned no account object, so the droplet and reserved-IP " +
        "limits cannot be read. This token is missing the `account:read` scope.",
      {
        label: "DigitalOcean token scopes",
        url: "https://docs.digitalocean.com/reference/api/create-personal-access-token/",
      },
    );
  }

  const readings: QuotaUsage[] = [];

  if (typeof account.droplet_limit === "number" && account.droplet_limit > 0) {
    const used = await countDoObjects(ctx, "/droplets");
    if (used !== null) {
      readings.push({
        id: "account/droplet_limit",
        service: "account",
        name: "Droplets",
        limit: account.droplet_limit,
        used,
        unit: "droplets",
        // DigitalOcean raises these on request through a support ticket, and
        // says so on the page linked below — so `true` is the provider's own
        // position rather than an assumption.
        adjustable: true,
        docsUrl: DOCS_URL,
      });
    }
  }

  if (typeof account.floating_ip_limit === "number" && account.floating_ip_limit > 0) {
    const used = await countDoObjects(ctx, "/reserved_ips");
    if (used !== null) {
      readings.push({
        // The key uses the API's field name, not the product's current name:
        // the id has to be stable across a rename, and DigitalOcean has
        // already demonstrated it renames the product without renaming the
        // field.
        id: "account/floating_ip_limit",
        service: "account",
        // The *label*, unlike the key, uses the current product name — this is
        // the string the user goes looking for in the console.
        name: "Reserved IPs",
        limit: account.floating_ip_limit,
        used,
        unit: "addresses",
        adjustable: true,
        docsUrl: DOCS_URL,
      });
    }
  }

  return readings;
}
