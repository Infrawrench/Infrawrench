/**
 * Shared Cloudflare API client used by all per-feature client modules.
 *
 * Wraps the low-level v4 REST primitives (`fetch`, `paginate`), caches the
 * resolved account ID, and exposes a few helpers (`getZoneOptions`,
 * `getAccessAppOptions`) that several create-flows share.
 */
export class CloudflareApi {
  readonly apiToken: string;
  readonly baseUrl = "https://api.cloudflare.com/client/v4";
  cfAccountId: string | null = null;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

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

  /** Paginate through Cloudflare's v4 API (page-based) */
  async paginate<T>(path: string, perPage = 50): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    for (;;) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${this.baseUrl}${path}${sep}page=${page}&per_page=${perPage}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Cloudflare API error ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        success: boolean;
        result: T[];
        result_info?: { total_pages: number; page: number };
      };
      if (!json.success || !Array.isArray(json.result)) break;
      results.push(...json.result);
      const totalPages = json.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return results;
  }

  /** Resolve the Cloudflare account ID from the first zone */
  async getAccountId(): Promise<string> {
    if (this.cfAccountId) return this.cfAccountId;
    const zones = await this.paginate<Record<string, unknown>>("/zones?per_page=1");
    const firstZone = zones[0];
    if (!firstZone)
      throw new Error("Cloudflare plugin: no zones found — cannot determine account ID");
    const account = firstZone["account"] as Record<string, unknown> | undefined;
    this.cfAccountId = String(account?.["id"] ?? "");
    if (!this.cfAccountId)
      throw new Error("Cloudflare plugin: could not determine account ID from zone");
    return this.cfAccountId;
  }

  async getZoneOptions(): Promise<Array<{ id: string; label: string }>> {
    const zones = await this.paginate<Record<string, unknown>>("/zones");
    return zones.map((z) => ({
      id: String(z["id"]),
      label: String(z["name"]),
    }));
  }

  async getAccessAppOptions(): Promise<Array<{ id: string; label: string }>> {
    const cfAccountId = await this.getAccountId();
    const apps = await this.paginate<Record<string, unknown>>(
      `/accounts/${cfAccountId}/access/apps`,
    );
    return apps.map((a) => ({
      id: String(a["id"]),
      label: String(a["name"] ?? a["domain"] ?? a["id"]),
    }));
  }
}
