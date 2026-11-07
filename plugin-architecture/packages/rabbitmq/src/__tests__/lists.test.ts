import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RabbitClient } from "../client.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";
const HOOK = Symbol.for("infrawrench.unreadListPart");

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  const fetchStub = vi.fn(() => {
    throw new Error("fetch must not be called when the host supplies http");
  });
  vi.stubGlobal("fetch", fetchStub);
  return {
    c: hostClient(
      new RabbitClient({ url: "mq.example.com:15672", username: "admin", password: "pw" }, {
        http,
      } as never),
    ),
    calls,
    fetchStub,
  };
}

const rows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, vhost: "/" }));

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, HOOK);
});

describe("paged lists", () => {
  it("throws at the page cap instead of returning part of the exchanges", async () => {
    const { c, calls } = client((call) => {
      const page = Number(call.url.searchParams.get("page"));
      return { items: rows(`x${page}-`, 500), page, page_count: 1_000_000 };
    });
    await expect(c.listResources("rabbitmq-exchange", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  for (const [typeId, path] of [
    ["rabbitmq-connection", "/api/connections"],
    ["rabbitmq-channel", "/api/channels"],
  ] as const) {
    it(`throws at the cap for ${typeId}`, async () => {
      const { c, calls } = client((call) => {
        const page = Number(call.url.searchParams.get("page"));
        return { items: rows(`c${page}-`, 500), page, page_count: 1_000_000 };
      });
      await expect(c.listResources(typeId, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(100);
      expect(calls.every((x) => x.url.pathname === path)).toBe(true);
    });
  }

  it("reads well past the old caps", async () => {
    const { c, calls } = client((call) => {
      const page = Number(call.url.searchParams.get("page"));
      return { items: rows(`x${page}-`, 500), page, page_count: 10 };
    });
    expect(await c.listResources("rabbitmq-exchange", ACCOUNT)).toHaveLength(5000);
    expect(calls).toHaveLength(10);
  });

  it("caps queues across every virtual host, not per host", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/api/vhosts") return [{ name: "/" }, { name: "b" }];
      const page = Number(call.url.searchParams.get("page"));
      return { items: rows(`q${page}-`, 500), page, page_count: 60 };
    });
    await expect(c.listResources("rabbitmq-queue", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    // 60 pages of "/" (30,000) and 40 of "b" reach 50,000; the 41st of "b" has more.
    expect(calls.length).toBeLessThanOrEqual(102);
  });

  it("returns a bare array from an old server whole", async () => {
    const { c } = client(() => rows("x", 2500));
    expect(await c.listResources("rabbitmq-exchange", ACCOUNT)).toHaveLength(2500);
  });

  it("refuses a page whose items key was renamed, first or later", async () => {
    const first = client(() => ({ queues: rows("x", 3), page: 1, page_count: 1 }));
    await expect(first.c.listResources("rabbitmq-exchange", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
    const later = client((call) => {
      const page = Number(call.url.searchParams.get("page"));
      return page === 1
        ? { items: rows("x", 500), page, page_count: 2 }
        : { error: "x", page, page_count: 2 };
    });
    await expect(later.c.listResources("rabbitmq-exchange", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("refuses a page with no page count", async () => {
    const { c } = client(() => ({ items: rows("x", 500) }));
    await expect(c.listResources("rabbitmq-connection", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads an empty paged list", async () => {
    const { c } = client(() => ({ items: [], page: 1, page_count: 0 }));
    expect(await c.listResources("rabbitmq-channel", ACCOUNT)).toEqual([]);
  });

  it("still fills a binding picker past the cap with what it read", async () => {
    const { c } = client((call) => {
      const page = Number(call.url.searchParams.get("page"));
      return {
        items: rows(`x${page}-`, 500).map((r) => ({ ...r, type: "topic" })),
        page,
        page_count: 1_000_000,
      };
    });
    const config = await c.getCreateConfig("rabbitmq-binding", "acct:rabbitmq-vhost:%2F");
    const source = config.fields.find((f) => f.key === "source");
    expect(source?.options?.length).toBeGreaterThan(0);
  });

  it("goes through the host's http without a CA and never calls fetch", async () => {
    const { c, calls, fetchStub } = client(() => ({ items: [], page: 1, page_count: 0 }));
    await c.listResources("rabbitmq-exchange", ACCOUNT);
    expect(calls).toHaveLength(1);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
