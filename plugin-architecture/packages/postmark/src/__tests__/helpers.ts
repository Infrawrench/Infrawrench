import { hostClient } from "@infrawrench/plugin-base/effect";
import { vi } from "vitest";
import { PostmarkClient } from "../client.js";

export const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

export type Route = (url: URL) => { status?: number; body?: unknown };

export function client(
  route: Route,
  credentials: Record<string, string> = { accountToken: "acct" },
) {
  const calls: URL[] = [];
  const request = vi.fn(async (req: { url: string }) => {
    const url = new URL(req.url);
    if (url.origin !== "https://api.postmarkapp.com") throw new Error(`unexpected ${req.url}`);
    calls.push(url);
    const reply = route(url);
    return {
      status: reply.status ?? 200,
      headers: {},
      body: reply.body === undefined ? "" : JSON.stringify(reply.body),
    };
  });
  const fetchStub = vi.fn(() => {
    throw new Error("fetch must not be called when the host supplies http");
  });
  vi.stubGlobal("fetch", fetchStub);
  return {
    c: hostClient(new PostmarkClient(credentials, { http: { request } } as never)),
    calls,
    request,
    fetchStub,
  };
}
