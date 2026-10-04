import type { TwilioContext } from "../api.js";

export interface Reply {
  status?: number;
  body?: unknown;
}

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  form?: URLSearchParams;
}

export const MAIN = "AC00000000000000000000000000000000";
export const SUB = "AC11111111111111111111111111111111";
export const KEY = "SK00000000000000000000000000000000";

/** Fake host HTTP service; requests are exercised end to end offline. */
export function makeHttp(route: (url: URL, method: string, form?: URLSearchParams) => Reply) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const form = typeof req.body === "string" ? new URLSearchParams(req.body) : undefined;
      calls.push({ url, method: req.method, headers: req.headers, ...(form ? { form } : {}) });
      const reply = route(url, req.method, form);
      const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

export function ctxWith(
  http: ReturnType<typeof makeHttp>["http"],
  authMode: "api-key" | "auth-token" = "auth-token",
): TwilioContext {
  return {
    accountSid: MAIN,
    username: authMode === "api-key" ? KEY : MAIN,
    password: "secret",
    authMode,
    http,
  };
}

export function record(
  category: string,
  price: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { category, price: String(price), price_unit: "usd", ...extra };
}

/** A 2010-API list page with no next page. */
export function page(key: string, items: unknown[]): Record<string, unknown> {
  return { [key]: items, next_page_uri: null };
}
