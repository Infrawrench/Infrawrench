import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNREAD_HOOK, client } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

describe("server-scoped lists", () => {
  const unread = vi.fn();
  beforeEach(() => {
    unread.mockClear();
    Reflect.set(globalThis, UNREAD_HOOK, unread);
  });

  const TWO_SERVERS = {
    TotalCount: 3,
    Servers: [
      { ID: 1, Name: "a", ApiTokens: ["t1"] },
      { ID: 2, Name: "b", ApiTokens: ["t2"] },
      { ID: 3, Name: "no token", ApiTokens: [] },
    ],
  };

  it("names a refused server and a server with no token as unread, not empty", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/servers") return { body: TWO_SERVERS };
      return { body: { Webhooks: [{ ID: 4, Url: "https://hooks.example/x" }] } };
    });
    const { c: refusing } = client((url) => {
      if (url.pathname === "/servers") return { body: TWO_SERVERS };
      return { status: 401, body: { ErrorCode: 10, Message: "no" } };
    });
    expect((await c.listResources("postmark-webhook", "a")).map((r) => r.externalId)).toEqual([
      "1/4",
      "2/4",
    ]);
    expect(unread).toHaveBeenCalledWith({ parentResourceIds: ["a:postmark-server:3"] });
    unread.mockClear();
    expect(await refusing.listResources("postmark-webhook", "a")).toEqual([]);
    expect(unread).toHaveBeenCalledWith({
      parentResourceIds: ["a:postmark-server:1", "a:postmark-server:2", "a:postmark-server:3"],
    });
  });

  it("still shows the refusal where the host keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { c } = client((url) =>
      url.pathname === "/servers"
        ? { body: TWO_SERVERS }
        : { status: 401, body: { ErrorCode: 10, Message: "no" } },
    );
    await expect(c.listResources("postmark-webhook", "a")).rejects.toThrow(/401/);
  });

  it("fails a webhook or stream list whose answer has no list", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/servers") return { body: TWO_SERVERS };
      return { body: { Message: "maintenance" } };
    });
    await expect(c.listResources("postmark-webhook", "a")).rejects.toThrow("is not a list");
    await expect(c.listResources("postmark-message-stream", "a")).rejects.toThrow("is not a list");
  });
});
