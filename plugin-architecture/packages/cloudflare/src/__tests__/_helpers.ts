import { vi } from "vitest";
import type { CloudflareApi } from "../clients/shared.js";

/** Wrap a list of items in an async-iterable, matching the SDK's `.list()`. */
export function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}

/**
 * Build a fake CloudflareApi. `cf` is the nested SDK namespace tree the
 * function under test reaches into; pass only what's needed. `getAccountId`,
 * `getZoneOptions`, `listZones`, `fetch`, `collect` are stubbed with sensible
 * defaults but can be overridden per test.
 */
export function makeApi(over: Partial<Record<string, unknown>> = {}): CloudflareApi {
  const base = {
    apiToken: "tok",
    baseUrl: "https://api.cloudflare.com/client/v4",
    cfAccountId: null as string | null,
    getAccountId: vi.fn(async () => "acct-cf"),
    getZoneOptions: vi.fn(async () => [{ id: "z1", label: "a.com" }]),
    getAccessAppOptions: vi.fn(async () => [{ id: "app1", label: "App One" }]),
    listZones: vi.fn(async () => [{ id: "z1", name: "a.com" }]),
    fetch: vi.fn(async () => ({})),
    collect: async <T>(it: AsyncIterable<T>): Promise<T[]> => {
      const out: T[] = [];
      for await (const x of it) out.push(x);
      return out;
    },
    cf: {},
  };
  return { ...base, ...over } as unknown as CloudflareApi;
}
