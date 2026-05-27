/**
 * Shared Cloudflare API client used by all per-feature client modules.
 *
 * Wraps the official `cloudflare` SDK and caches the resolved account ID.
 * The `fetch` escape hatch remains because the SDK does not expose the R2
 * object plane — see `r2-client.ts`. New code should prefer the SDK
 * namespaces exposed via `api.cf`.
 */
import Cloudflare from "cloudflare";
import type { Zone } from "cloudflare/resources/zones/zones";

export class CloudflareApi {
  readonly apiToken: string;
  readonly baseUrl = "https://api.cloudflare.com/client/v4";
  readonly cf: Cloudflare;
  cfAccountId: string | null = null;
  private zonesPromise: Promise<Zone[]> | null = null;
  private accountIdPromise: Promise<string> | null = null;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
    // Loading an account fans out into per-zone list calls across many resource
    // types, so brief 429 bursts are expected. The SDK retries 429s with
    // exponential backoff and honors the Retry-After header; raise the budget
    // above the default of 2 to ride out those bursts.
    this.cf = new Cloudflare({ apiToken, maxRetries: 5 });
  }

  /**
   * Raw fetch wrapper. Retained only for the R2 object plane (uploads,
   * deletes, list-objects), which the SDK does not expose. Do not add new
   * call sites — use `this.cf` instead.
   */
  async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Cloudflare API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    const json = (await res.json()) as {
      success: boolean;
      result: T;
      errors?: Array<{ message: string }>;
    };
    if (!json.success) {
      const msgs = json.errors?.map((e) => e.message).join(", ") ?? "unknown error";
      throw new Error(`Cloudflare API error for ${path}: ${msgs}`);
    }
    return json.result;
  }

  /** Collect all items from an SDK PagePromise into an array. */
  async collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of pages) out.push(item);
    return out;
  }

  /**
   * Full account zone list, fetched once per client and shared across callers.
   *
   * Opening an account view fans out into ~25 concurrent listResources calls,
   * most of which enumerate zones; without a shared cache each would
   * re-paginate /zones and together trip Cloudflare's rate limit (429). The
   * in-flight promise is cached (not just the resolved value) so concurrent
   * callers await the same request. A failed fetch clears the cache so the
   * next caller can retry.
   */
  listZones(): Promise<Zone[]> {
    if (!this.zonesPromise) {
      this.zonesPromise = this.collect(this.cf.zones.list()).then(
        (zones) => {
          // Side effect: cache account ID so account-scoped callers can skip
          // their own lookup.
          if (!this.cfAccountId && zones[0]?.account?.id) {
            this.cfAccountId = zones[0].account.id;
          }
          return zones;
        },
        (err) => {
          this.zonesPromise = null;
          throw err;
        },
      );
    }
    return this.zonesPromise;
  }

  /**
   * Resolve the Cloudflare account ID from the first zone. Deduped across
   * concurrent callers via a cached promise — without it the fan-out of
   * account-scoped listers each fires its own /zones?per_page=1 request.
   */
  async getAccountId(): Promise<string> {
    if (this.cfAccountId) return this.cfAccountId;
    if (!this.accountIdPromise) {
      this.accountIdPromise = this.resolveAccountId().catch((err) => {
        this.accountIdPromise = null;
        throw err;
      });
    }
    return this.accountIdPromise;
  }

  private async resolveAccountId(): Promise<string> {
    for await (const zone of this.cf.zones.list({ per_page: 1 })) {
      const accountId = zone.account?.id ?? "";
      if (!accountId)
        throw new Error("Cloudflare plugin: could not determine account ID from zone");
      this.cfAccountId = accountId;
      return accountId;
    }
    throw new Error("Cloudflare plugin: no zones found — cannot determine account ID");
  }

  async getZoneOptions(): Promise<Array<{ id: string; label: string }>> {
    const zones = await this.listZones();
    return zones.map((z) => ({ id: z.id, label: z.name }));
  }

  async getAccessAppOptions(): Promise<Array<{ id: string; label: string }>> {
    const account_id = await this.getAccountId();
    const opts: Array<{ id: string; label: string }> = [];
    for await (const a of this.cf.zeroTrust.access.applications.list({ account_id })) {
      const app = a as Record<string, unknown>;
      const id = String(app["id"] ?? "");
      const label = String(app["name"] ?? app["domain"] ?? id);
      opts.push({ id, label });
    }
    return opts;
  }
}
