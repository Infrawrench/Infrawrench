import type { HttpHostServices } from "@infrawrench/plugin-base";
import { createLinodeApi } from "../api.js";

export const BASE = "https://linode.test";

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
}

export type FakeAnswer = { status?: number; json?: unknown; text?: string };

export type FakeRoute = (call: FakeCall) => FakeAnswer | undefined;

export function httpError(status: number): FakeAnswer {
  return { status, json: { errors: [{ reason: `failed with ${status}` }] } };
}

/** A Linode page, as every collection answers. */
export function page(data: unknown[], at = 1, pages = 1): FakeAnswer {
  return { json: { data, page: at, pages, results: data.length } };
}

/**
 * A client over a transport that answers only what `route` knows, so nothing can
 * reach a provider and a request a test did not expect fails it.
 */
export function fakeApi(route: FakeRoute, caCert?: string) {
  const calls: FakeCall[] = [];
  const request = async ({
    url,
    method,
  }: Parameters<HttpHostServices["request"]>[0]): ReturnType<HttpHostServices["request"]> => {
    if (!url.startsWith(BASE)) throw new Error(`unexpected request to ${url}`);
    const parsed = new URL(url);
    const call = { method, path: parsed.pathname, query: parsed.searchParams };
    calls.push(call);
    const answer = route(call);
    if (!answer) throw new Error(`unexpected ${method} ${parsed.pathname}${parsed.search}`);
    return {
      status: answer.status ?? 200,
      headers: {},
      body: answer.text ?? JSON.stringify(answer.json),
    };
  };
  const api = createLinodeApi({
    token: "t",
    baseUrl: BASE,
    services: { http: { request } },
    ...(caCert ? { caCert } : {}),
  });
  return { api, calls };
}
