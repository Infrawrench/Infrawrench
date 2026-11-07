import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("domain DNS records", () => {
  const LIST = { TotalCount: 1, Domains: [{ ID: 36735, Name: "example.com" }] };

  it("fails the DNS records when a domain's details cannot be read", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/domains") return { body: LIST };
      return { status: 500, body: { ErrorCode: 0, Message: "oops" } };
    });
    await expect(c.listResources("postmark-dns-record", "a")).rejects.toThrow(/500/);
    // The domain itself is in the list, so it still lists from the list row.
    expect((await c.listResources("postmark-domain", "a")).map((d) => d.externalId)).toEqual([
      "36735",
    ]);
  });

  it("reads a domain gone since the list as having no records", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/domains") return { body: LIST };
      return { status: 404, body: { ErrorCode: 510, Message: "not found" } };
    });
    expect(await c.listResources("postmark-dns-record", "a")).toEqual([]);
  });
});
