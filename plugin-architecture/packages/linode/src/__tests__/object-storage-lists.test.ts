import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteObject, listObjects } from "../object-storage.js";
import { fakeApi, type FakeCall } from "./fake-linode.js";

const SIGNED = "https://us-east-1.linodeobjects.com/signed";
const LIST = "/object-storage/buckets/us-east/b/object-list";
const SIGN = "/object-storage/buckets/us-east/b/object-url";

const row = (name: string) => ({ name, size: 1, last_modified: "2026-01-01T00:00:00" });

/** The bucket's listing, plus signed URLs for anything that gets that far. */
function bucket(list: (call: FakeCall) => unknown) {
  return fakeApi((call) => {
    if (call.path === LIST) return { json: list(call) };
    if (call.path === SIGN) return { json: { url: SIGNED, exists: true } };
    return undefined;
  });
}

const signed = (calls: FakeCall[]) => calls.filter((c) => c.path === SIGN);

describe("the object list", () => {
  const deleted: string[] = [];

  beforeEach(() => {
    deleted.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === SIGNED && init.method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("follows next_marker to the end", async () => {
    const { api, calls } = bucket(({ query }) =>
      query.get("marker")
        ? { data: [row("b")], is_truncated: false, next_marker: null }
        : { data: [row("a")], is_truncated: true, next_marker: "a" },
    );
    const rows = await listObjects(api, "us-east/b", "");
    expect(rows.map((r) => r.key)).toEqual(["a", "b"]);
    expect(calls.map((c) => c.query.get("page_size"))).toEqual(["500", "500"]);
  });

  it("throws at the page cap when browsing", async () => {
    const { api, calls } = bucket(({ query }) => ({
      data: [row(`k${query.get("marker") ?? ""}`)],
      is_truncated: true,
      next_marker: `${query.get("marker") ?? ""}x`,
    }));
    await expect(listObjects(api, "us-east/b", "")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(200);
  });

  it("deletes nothing from a folder too long to read whole", async () => {
    const { api, calls } = bucket(({ query }) => ({
      data: [row(`f/${query.get("marker") ?? ""}`)],
      is_truncated: true,
      next_marker: `${query.get("marker") ?? ""}x`,
    }));
    await expect(deleteObject(api, "us-east/b", "f/")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(signed(calls)).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("throws on a page with its list renamed", async () => {
    const { api, calls } = bucket(() => ({ objects: [], is_truncated: false }));
    await expect(listObjects(api, "us-east/b", "")).rejects.toThrow("is not a list");
    await expect(deleteObject(api, "us-east/b", "f/")).rejects.toThrow("is not a list");
    expect(signed(calls)).toEqual([]);
  });

  it("reads on from the last name when a truncated page gives no next_marker", async () => {
    const { api, calls } = bucket(({ query }) =>
      query.get("marker") === "f/500"
        ? { data: [row("f/501")], is_truncated: false, next_marker: null }
        : { data: [row("f/500")], is_truncated: true, next_marker: null },
    );
    await deleteObject(api, "us-east/b", "f/");
    expect(signed(calls)).toHaveLength(3);
    expect(deleted).toHaveLength(3);
  });

  it("deletes nothing when a truncated page gives nothing to read on from", async () => {
    const { api, calls } = bucket(() => ({ data: [], is_truncated: true, next_marker: null }));
    await expect(deleteObject(api, "us-east/b", "f/")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(signed(calls)).toEqual([]);
  });
});
