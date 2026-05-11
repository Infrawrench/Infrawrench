/**
 * Shared Cloudflare API client used by all per-feature client modules.
 *
 * Wraps the official `cloudflare` SDK and caches the resolved account ID.
 * A few legacy helpers (`fetch`, `paginate`) remain because the SDK does not
 * expose the R2 object plane — see `r2-client.ts`. New code should prefer
 * the SDK namespaces exposed via `api.cf`.
 */
import Cloudflare from "cloudflare";

export class CloudflareApi {
  readonly apiToken: string;
  readonly baseUrl = "https://api.cloudflare.com/client/v4";
  readonly cf: Cloudflare;
  cfAccountId: string | null = null;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
    this.cf = new Cloudflare({ apiToken });
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

  /** Resolve the Cloudflare account ID from the first zone */
  async getAccountId(): Promise<string> {
    if (this.cfAccountId) return this.cfAccountId;
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
    const opts: Array<{ id: string; label: string }> = [];
    for await (const z of this.cf.zones.list()) {
      // Side effect: cache account ID for later calls.
      if (z.account?.id && !this.cfAccountId) {
        this.cfAccountId = z.account.id;
      }
      opts.push({ id: z.id, label: z.name });
    }
    return opts;
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
