/**
 * Workers KV over Cloudflare's REST API, for code that has no KV binding: the
 * sync script on a GitHub runner, and the API when it runs on the Node gateway.
 */

const API = "https://api.cloudflare.com/client/v4";

/** Bulk writes take up to 10,000 pairs and 100 MB; values go base64-encoded. */
export const BULK_MAX_PAIRS = 10_000;
export const BULK_MAX_BYTES = 50 * 1024 * 1024;

export interface KvRestConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  fetch?: typeof fetch;
}

export interface KvPair {
  key: string;
  value: Uint8Array;
  metadata?: Record<string, unknown>;
}

export class KvRest {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly config: KvRestConfig) {
    this.base = `${API}/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}`;
    this.fetch = config.fetch ?? fetch;
  }

  /** A value's bytes, or null when the key is not there. */
  async get(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const res = await this.request(`/values/${encodeURIComponent(key)}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    await this.check(res, `reading ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getJson<T>(key: string): Promise<T | null> {
    const bytes = await this.get(key);
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null;
  }

  /** Write up to {@link BULK_MAX_PAIRS} pairs in one request. */
  async putMany(pairs: KvPair[]): Promise<void> {
    if (pairs.length === 0) return;
    const body = pairs.map(({ key, value, metadata }) => ({
      key,
      value: Buffer.from(value).toString("base64"),
      base64: true,
      ...(metadata ? { metadata } : {}),
    }));
    const res = await this.request("/bulk", { method: "PUT", body: JSON.stringify(body) });
    await this.check(res, `writing ${pairs.length} keys`);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const res = await this.request("/bulk/delete", { method: "POST", body: JSON.stringify(keys) });
    await this.check(res, `deleting ${keys.length} keys`);
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  }

  /** Throws on an HTTP error, or a bulk write Cloudflare took only part of. */
  private async check(res: Response, what: string): Promise<void> {
    if (!res.ok) {
      throw new Error(`Workers KV: ${what} failed with ${res.status}: ${await res.text()}`);
    }
    if (res.headers.get("content-type")?.includes("application/json")) {
      const body = (await res.clone().json()) as {
        success?: boolean;
        result?: { unsuccessful_keys?: string[] } | null;
      };
      const failed = body.result?.unsuccessful_keys ?? [];
      if (body.success === false || failed.length > 0) {
        throw new Error(`Workers KV: ${what} failed: ${JSON.stringify(body).slice(0, 500)}`);
      }
    }
  }
}
