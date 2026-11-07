import { afterEach, describe, expect, it, vi } from "vitest";
import { UNREAD_HOOK, client } from "./helpers.js";

const offsetOf = (url: URL) => Number(url.searchParams.get("offset"));
const fullPage = (offset: number) =>
  Array.from({ length: 500 }, (_, i) => ({ ID: offset + i, Name: `s${offset + i}` }));

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

describe("count/offset lists", () => {
  it("throws at the cap instead of returning the first 10,000 servers as all of them", async () => {
    const { c, calls } = client((url) =>
      url.pathname === "/servers"
        ? { body: { TotalCount: 1_000_000, Servers: fullPage(offsetOf(url)) } }
        : { status: 404 },
    );
    await expect(c.listResources("postmark-server", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(20);
  });

  it("reads to the end of a list exactly at the cap", async () => {
    const { c } = client((url) =>
      url.pathname === "/servers"
        ? { body: { TotalCount: 10_000, Servers: fullPage(offsetOf(url)) } }
        : { status: 404 },
    );
    expect(await c.listResources("postmark-server", "a")).toHaveLength(10_000);
  });

  it("keeps reading a full page when TotalCount is missing", async () => {
    const { c } = client((url) =>
      url.pathname === "/domains"
        ? { body: { Domains: offsetOf(url) === 0 ? fullPage(0) : [{ ID: 9999, Name: "z" }] } }
        : { status: 404 },
    );
    expect(await c.listResources("postmark-domain", "a")).toHaveLength(501);
  });

  it("rejects a page whose list is not an array, on the first page and a later one", async () => {
    const first = client((url) =>
      url.pathname === "/senders"
        ? { body: { TotalCount: 1, Signatures: [{ ID: 1 }] } }
        : { status: 404 },
    );
    await expect(first.c.listResources("postmark-sender-signature", "a")).rejects.toThrow(
      "is not a list",
    );
    const later = client((url) =>
      url.pathname === "/senders"
        ? {
            body:
              offsetOf(url) === 0
                ? { TotalCount: 600, SenderSignatures: fullPage(0) }
                : { TotalCount: 600, Error: "busy" },
          }
        : { status: 404 },
    );
    await expect(later.c.listResources("postmark-sender-signature", "a")).rejects.toThrow(
      "is not a list",
    );
  });

  it("goes through the host's http without a CA and never calls fetch", async () => {
    const { c, request, fetchStub } = client((url) =>
      url.pathname === "/servers" ? { body: { TotalCount: 0, Servers: [] } } : { status: 404 },
    );
    expect(await c.listResources("postmark-server", "a")).toEqual([]);
    expect(request).toHaveBeenCalled();
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
