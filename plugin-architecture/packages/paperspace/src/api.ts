import { createApiClient, type ApiClient, type HostServices } from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Transport for the Paperspace API (`https://api.paperspace.com/v1`, typed from
 * the OpenAPI document at `/v1/openapi.json`, docs at
 * docs.digitalocean.com/reference/paperspace; checked 2026-10). This is the API
 * Paperspace launched on 2024-05-15 after DigitalOcean's acquisition; the legacy
 * Core and Gradient endpoints it
 * replaced no longer answer. Auth is `Authorization: Bearer <api key>`;
 * errors are `{code, message, details?}`. Lists are cursor paginated:
 * `?after=<nextPage>&limit=<=120`, answering `{items, hasMore, nextPage}`.
 */

export const API_BASE = "https://api.paperspace.com/v1";

export class PaperspaceApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    let code = "";
    let message = body.slice(0, 500) || "(empty response)";
    try {
      const p: { code?: string; message?: string } = JSON.parse(body);
      if (p.message) message = p.message;
      code = p.code ?? "";
    } catch {
      /* not JSON */
    }
    super(`Paperspace API error ${status} for ${path}: ${message}`);
    this.name = "PaperspaceApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type PaperspaceApi = ApiClient<paths>;

/** The usual hand-written transport: the host's service whenever there is one. */
export function createPaperspaceApi(
  apiKey: string,
  caCert: string,
  services: HostServices | undefined,
): PaperspaceApi {
  return createApiClient<paths>({
    vendor: "Paperspace",
    baseUrl: API_BASE,
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    http: services?.http,
    caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    // The host's answer can arrive with no body at all, whatever its type says.
    httpError: ({ status, path, body }) => new PaperspaceApiError(status, path, body ?? ""),
  });
}

interface ListPage<Item> {
  items?: Item[];
  hasMore?: boolean;
  nextPage?: string | null;
}

/**
 * Every page of a cursor-paginated list, by a function fetching one, so each call
 * stays typed from its route. Not `withCursorPagination`, which reads an `items`
 * that is not an array as an empty page: here that fails the listing, rather than
 * telling the host a team's resources are gone.
 */
export async function listAll<Item>(
  fetchPage: (query: { limit: number; after?: string }) => Promise<ListPage<Item> | undefined>,
): Promise<Item[]> {
  const out: Item[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await fetchPage({ limit: 120, ...(after ? { after } : {}) });
    out.push(...(res?.items ?? []));
    after = res?.hasMore && res.nextPage ? String(res.nextPage) : undefined;
    if (!after) break;
  }
  return out;
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof PaperspaceApiError && statuses.includes(err.status);
}
