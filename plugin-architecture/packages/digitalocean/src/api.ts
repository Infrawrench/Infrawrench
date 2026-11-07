/**
 * The DigitalOcean control-plane client, typed from DO's OpenAPI document by
 * plugingen (`../plugingen.json`). Every provider call goes through the host's HTTP
 * service when there is one, including the ones `DoApi.fetch` makes off this API.
 *
 * Ids go into paths and queries as written, which is what the plugin has always
 * sent (#417): `unencodedSegment` where a path holds one, `encodeQuery` for the query.
 */
import {
  createApiClient,
  hostFetch,
  hostTransport,
  restRequest,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

const BASE_URL = "https://api.digitalocean.com/v2";

/** An operation's response, by its `operationId`. */
export type DoResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

/** A request {@link DoApi.written} sends as given. */
export interface WrittenRequest {
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

export type DoApi = ApiClient<paths> & {
  /**
   * A request written out whole, typed by the operation it calls, for what the
   * typed client cannot send unchanged: a query after a path whose id may hold a
   * `?` (the client would write `&` rather than a second `?`), or a body that does
   * not fit the document, such as one echoed from whatever the last GET returned.
   */
  written<Op extends keyof operations>(
    path: string,
    request?: WrittenRequest,
  ): Promise<DoResponse<Op>>;
  /**
   * A call off this API: the inference hosts, Spaces, a signed log URL. `stream` is
   * for an answer that must arrive as it is written.
   */
  fetch(url: string, init?: RequestInit, options?: { stream?: boolean }): Promise<Response>;
};

/**
 * DO's generic `{"id":"forbidden","message":"failed to create agent"}` tells the
 * user nothing actionable. Translate the common cause (missing GenAI scopes on the
 * personal access token) into a pointer at the fix. Same root cause for the other
 * gen-ai and dedicated-inference endpoints, so cover both.
 */
function withScopeHint(err: unknown, path: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (
    !message.includes("403") ||
    !(path.startsWith("/gen-ai/") || path.startsWith("/dedicated-inferences"))
  ) {
    return err;
  }
  const product = path.startsWith("/dedicated-inferences") ? "Dedicated Inference" : "Gradient AI";
  return new Error(
    `${message}\n\n` +
      `Hint: this is almost always the API token's scope. DigitalOcean ` +
      `${product} endpoints need the \`genai:create\` / \`genai:read\` / ` +
      `\`genai:update\` / \`genai:delete\` scopes (and ` +
      `\`dedicated_inference:*\` for Dedicated Inference), which older ` +
      `personal access tokens don't include. Mint a new token at ` +
      `https://cloud.digitalocean.com/account/api/tokens with the GenAI ` +
      `(or "Full Access") scope and update this account's credentials.`,
  );
}

/** Any failure of a call, not only an HTTP status, gets {@link withScopeHint}. */
function hinted<Send>(send: Send): Send;
function hinted(send: (path: string, ...rest: unknown[]) => Promise<unknown>) {
  return async (path: string, ...rest: unknown[]) => {
    try {
      return await send(path, ...rest);
    } catch (err) {
      throw withScopeHint(err, path);
    }
  };
}

export function createDoApi(token: string, http?: HttpHostServices): DoApi {
  const headers = { Authorization: `Bearer ${token}` };
  const client = createApiClient<paths>({
    vendor: "DO",
    baseUrl: BASE_URL,
    headers,
    encodeQuery: (value) => value,
    http,
  });
  const sendWritten = async <Body>(path: string, request?: WrittenRequest) => {
    const answer = await restRequest<Body>({
      vendor: "DO",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers,
      ...hostTransport(http),
      ...(request ? { init: request } : {}),
    });
    return answer;
  };
  return {
    ...client,
    get: hinted(client.get),
    post: hinted(client.post),
    put: hinted(client.put),
    patch: hinted(client.patch),
    delete: hinted(client.delete),
    written: hinted(
      async <Op extends keyof operations>(path: string, request?: WrittenRequest) =>
        (await sendWritten<DoResponse<Op>>(path, request)).body,
    ),
    fetch: (url, init, options) => hostFetch({ http, ...options }, url, init),
  };
}
