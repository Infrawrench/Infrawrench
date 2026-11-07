import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  commaSeparated,
  createApiClient,
  pathEncode,
  unencodedSegment,
  withCursorPagination,
  withPagination,
  type ApiClient,
  type ApiListItem,
  type ApiResponse,
} from "../api-client.js";
import type { HttpHostServices } from "../manifest.js";

/** The shape `openapi-typescript` emits, reduced to what the client reads. */
interface Item {
  id: number;
  name: string;
}
type Json<T> = { content: { "application/json": T } };
type NoContent = { content?: never };

type Get<Query, Response> = {
  get: {
    parameters: { query?: Query };
    requestBody?: never;
    responses: { 200: Json<Response> };
  };
  put?: never;
  post?: never;
  delete?: never;
  patch?: never;
};

interface paths {
  // The shapes `withCursorPagination` has to read, one per way providers do it.
  "/nested": Get<
    { limit?: number; until?: number; sort?: "name" },
    { things: Item[]; pagination: { next: number | null } }
  >;
  "/union": Get<
    { limit?: number; until?: number },
    string | { things: Item[] } | { things: Item[]; pagination: { next: string | null } | null }
  >;
  "/nullable": Get<
    { limit?: number; until?: number },
    { things: Item[]; pagination: { next: number | null } } | null
  >;
  "/no-size": Get<{ until?: number }, { things: Item[]; pagination: { next: number | null } }>;
  "/no-cursor-param": Get<
    { limit?: number },
    { things: Item[]; pagination: { next: number | null } }
  >;
  "/no-cursor-field": Get<{ limit?: number; until?: number }, { things: Item[] }>;
  "/object-cursor": Get<
    { limit?: number; until?: number },
    { things: Item[]; pagination: { next: { id: string } } }
  >;
  "/last-item": Get<
    { limit?: number; after?: string },
    { data: Item[]; has_more: boolean; other: string[] }
  >;
  "/root-array": Get<{ limit?: number; cursor?: string }, { cursor: string; thing: Item }[]>;
  "/token": Get<
    { pageSize?: number; pageToken?: string },
    { things?: Item[]; nextPageToken?: string }
  >;
  "/link": Get<
    { "page[size]"?: number; "page[after]"?: string },
    { data: Item[]; links: { next?: string | null } }
  >;
  "/items": {
    get: {
      parameters: {
        query?: {
          page?: number;
          per_page?: number;
          tag?: string[];
          sort?: "name" | "id";
          note?: string | null | undefined;
        };
      };
      requestBody?: never;
      responses: {
        200: Json<{ items: Item[]; meta?: { total?: number | null } }>;
        "4xx": Json<{ error: string }>;
      };
    };
    put?: never;
    post: {
      parameters: { query?: never };
      requestBody: Json<{ name: string; size?: number; kind?: "a" | "b" }>;
      responses: { 201: Json<{ item: Item }> };
    };
    delete?: never;
    patch?: never;
  };
  "/items/{id}": {
    get: {
      parameters: { query?: never; path: { id: number } };
      requestBody?: never;
      responses: { 200: Json<{ item: Item }> };
    };
    put?: never;
    post?: never;
    delete: {
      parameters: { query?: never; path: { id: number } };
      requestBody?: never;
      responses: { 204: NoContent };
    };
    patch: {
      parameters: { query?: never; path: { id: number } };
      requestBody?: Json<{ name?: string }>;
      responses: { 200: Json<{ item: Item }> };
    };
  };
  "/items/{id}/metrics": {
    get: {
      parameters: { query: { type: ("cpu" | "disk")[]; start: string }; path: { id: number } };
      requestBody?: never;
      responses: { 200: Json<{ points: number[] }> };
    };
    put?: never;
    post?: never;
    delete?: never;
    patch?: never;
  };
  "/single": {
    get: {
      parameters: { query?: never };
      requestBody?: never;
      responses: { 200: Json<{ detail: { name: string } }> };
    };
    put?: never;
    post?: never;
    delete?: never;
    patch?: never;
  };
}

const BASE = "https://api.example.test/v1";

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

function client() {
  return createApiClient<paths>({
    vendor: "Example",
    baseUrl: BASE,
    headers: { Authorization: "Bearer t" },
  });
}

let fetchMock: MockInstance<typeof fetch>;

const lastUrl = () => String(fetchMock.mock.lastCall?.[0]);
const lastInit = () => fetchMock.mock.lastCall?.[1];

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pathEncode", () => {
  it("encodes anything that would change the shape of the path", () => {
    expect(pathEncode("a/b")).toBe("a%2Fb");
    expect(pathEncode("*.a b")).toBe("*.a%20b");
    expect(pathEncode("@")).toBe("%40");
    expect(pathEncode("../admin")).toBe("..%2Fadmin");
  });

  it("takes numbers", () => {
    expect(pathEncode(42)).toBe("42");
  });

  it("lands in the URL as one segment", async () => {
    await client().get(`/items/${pathEncode("a/b")}`);
    expect(lastUrl()).toBe(`${BASE}/items/a%2Fb`);
  });
});

describe("query strings", () => {
  it("sends no question mark without a query, or with an empty one", async () => {
    await client().get("/items");
    expect(lastUrl()).toBe(`${BASE}/items`);
    await client().get("/items", { query: {} });
    expect(lastUrl()).toBe(`${BASE}/items`);
  });

  it("keeps the caller's key order and skips undefined and null", async () => {
    await client().get("/items", { query: { sort: "name", note: undefined, page: 2, tag: ["x"] } });
    expect(lastUrl()).toBe(`${BASE}/items?sort=name&page=2&tag=x`);
    await client().get("/items", { query: { note: null } });
    expect(lastUrl()).toBe(`${BASE}/items`);
  });

  it("repeats a key for an array by default", async () => {
    await client().get("/items", { query: { tag: ["a", "b"] } });
    expect(lastUrl()).toBe(`${BASE}/items?tag=a&tag=b`);
  });

  it("form-encodes values", async () => {
    await client().get(`/items/${pathEncode(1)}/metrics`, {
      query: { type: ["cpu"], start: "2026-01-01T00:00:00.000Z" },
    });
    expect(lastUrl()).toBe(`${BASE}/items/1/metrics?type=cpu&start=2026-01-01T00%3A00%3A00.000Z`);
    await client().get("/items", { query: { tag: ["a b&c"] } });
    expect(lastUrl()).toBe(`${BASE}/items?tag=a+b%26c`);
  });

  it("joins commaSeparated with raw commas, still encoding each item", async () => {
    await client().get(`/items/${pathEncode(1)}/metrics`, {
      query: { type: commaSeparated(["cpu", "disk"]), start: "x" },
    });
    expect(lastUrl()).toBe(`${BASE}/items/1/metrics?type=cpu,disk&start=x`);
    await client().get("/items", { query: { tag: commaSeparated(["a,b", "c d"]) } });
    expect(lastUrl()).toBe(`${BASE}/items?tag=a%2Cb,c+d`);
  });

  it("leaves commaSeparated a plain array to anything else that reads it", () => {
    const list = commaSeparated(["a", "b"]);
    expect(Array.isArray(list)).toBe(true);
    expect(JSON.stringify(list)).toBe('["a","b"]');
    expect(Object.keys(list)).toEqual(["0", "1"]);
  });
});

describe("requests", () => {
  it("sends the method, JSON body and headers", async () => {
    fetchMock.mockResolvedValueOnce(response({ item: { id: 1, name: "n" } }, 201));
    const { item } = await client().post("/items", { body: { name: "n", size: 2 } });
    expect(item.id).toBe(1);
    const init = lastInit();
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"name":"n","size":2}');
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer t",
      "Content-Type": "application/json",
    });
  });

  it("drops an undefined field from the body", async () => {
    const name: string | undefined = undefined;
    await client().post("/items", { body: { name, size: 2 } });
    expect(lastInit()?.body).toBe('{"size":2}');
  });

  it("sends no body when there is none", async () => {
    await client().get("/items");
    expect(lastInit()?.body).toBeUndefined();
  });

  it("resolves headers from a function on every request", async () => {
    let token = 0;
    const api = createApiClient<paths>({
      vendor: "Example",
      baseUrl: BASE,
      headers: async () => ({ Authorization: `Bearer ${++token}` }),
    });
    await api.get("/items");
    await api.get("/items");
    expect(lastInit()?.headers).toMatchObject({ Authorization: "Bearer 2" });
  });

  it("returns undefined for a 204", async () => {
    fetchMock.mockResolvedValueOnce(response(null, 204));
    await expect(client().delete(`/items/${pathEncode(1)}`)).resolves.toBeUndefined();
  });

  it("names the path and query in an error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(client().get("/items", { query: { page: 2 } })).rejects.toThrow(
      "Example API error 500 for /items?page=2: nope",
    );
  });

  it("forwards an abort signal", async () => {
    const { signal } = new AbortController();
    await client().get("/items", { signal });
    expect(lastInit()?.signal).toBe(signal);
  });

  it("goes through the host's http service when given one", async () => {
    const request = vi.fn<HttpHostServices["request"]>(async () => ({
      status: 200,
      headers: {},
      body: '{"detail":{"name":"n"}}',
    }));
    const api = createApiClient<paths>({
      vendor: "Example",
      baseUrl: BASE,
      headers: {},
      http: { request },
      caCert: "PEM",
    });
    const { detail } = await api.get("/single");
    expect(detail.name).toBe("n");
    expect(request.mock.lastCall?.[0]).toMatchObject({
      url: `${BASE}/single`,
      method: "GET",
      caCert: "PEM",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("withPagination", () => {
  const items = (count: number, offset = 0): Item[] =>
    Array.from({ length: count }, (_, i) => ({ id: offset + i, name: `i${offset + i}` }));

  const paged = () =>
    withPagination(client(), {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: 2,
      total: (page: { meta?: { total?: number | null } }) => page.meta?.total,
    });

  const urls = () => fetchMock.mock.calls.map(([url]) => String(url).replace(BASE, ""));

  it("walks every page, appending the page params after the caller's query", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ items: items(2) }))
      .mockResolvedValueOnce(response({ items: items(1, 2) }));
    const all = await paged().getAll("/items", "items", { query: { sort: "name" } });
    expect(all.map((item) => item.id)).toEqual([0, 1, 2]);
    expect(urls()).toEqual([
      "/items?sort=name&page=1&per_page=2",
      "/items?sort=name&page=2&per_page=2",
    ]);
  });

  it("stops at the reported total without asking for another page", async () => {
    fetchMock.mockResolvedValueOnce(response({ items: items(2), meta: { total: 2 } }));
    await expect(paged().getAll("/items", "items")).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a null total and stops on an empty page", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ items: items(2), meta: { total: null } }))
      .mockResolvedValueOnce(response({ items: [], meta: { total: null } }));
    await expect(paged().getAll("/items", "items")).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a missing root key as the end of the list", async () => {
    fetchMock.mockResolvedValueOnce(response({ meta: {} }));
    await expect(paged().getAll("/items", "items")).resolves.toEqual([]);
  });

  it("works without a total", async () => {
    fetchMock.mockResolvedValueOnce(response({ items: items(1) }));
    const api = withPagination(client(), { pageParam: "page", sizeParam: "per_page", pageSize: 2 });
    await expect(api.getAll("/items", "items")).resolves.toHaveLength(1);
  });

  it("keeps the client's other verbs", async () => {
    await paged().get("/single");
    expect(lastUrl()).toBe(`${BASE}/single`);
  });

  it("propagates a failed page", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(paged().getAll("/items", "items")).rejects.toThrow(
      "for /items?page=1&per_page=2: nope",
    );
  });
});

describe("client options", () => {
  const scoped = (extra: Partial<Parameters<typeof createApiClient>[0]> = {}) =>
    createApiClient<paths>({ vendor: "Example", baseUrl: BASE, headers: {}, ...extra });

  it("sends scopeQuery on every request, after the call's own query", async () => {
    const api = scoped({ scopeQuery: { teamId: "t1", gone: undefined, none: null } });
    await api.get("/items");
    expect(lastUrl()).toBe(`${BASE}/items?teamId=t1`);
    await api.get("/items", { query: { page: 2 } });
    expect(lastUrl()).toBe(`${BASE}/items?page=2&teamId=t1`);
  });

  it("sends nothing extra when every scope value is absent", async () => {
    await scoped({ scopeQuery: { teamId: undefined } }).get("/items");
    expect(lastUrl()).toBe(`${BASE}/items`);
  });

  it("keeps scopeQuery out of error messages", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(
      scoped({ scopeQuery: { teamId: "t1" } }).get("/items", { query: { page: 2 } }),
    ).rejects.toThrow(/^Example API error 500 for \/items\?page=2: nope$/);
  });

  it("form-encodes by default and takes another encoder", async () => {
    const value = "a b+c/~!'()*";
    await scoped({ scopeQuery: { v: value } }).get("/items");
    expect(lastUrl()).toBe(`${BASE}/items?v=a+b%2Bc%2F%7E%21%27%28%29*`);
    await scoped({ scopeQuery: { v: value }, encodeQuery: encodeURIComponent }).get("/items", {
      query: { tag: commaSeparated(["x y", "z"]) },
    });
    expect(lastUrl()).toBe(`${BASE}/items?tag=x%20y,z&v=a%20b%2Bc%2F~!'()*`);
  });

  it("sends an unencoded segment as given, and joins the query onto a `?` it holds", async () => {
    const api = scoped({ scopeQuery: { teamId: "t1" } });
    await api.get(`/items/${unencodedSegment("a b/c")}`);
    expect(lastUrl()).toBe(`${BASE}/items/a b/c?teamId=t1`);
    await api.get(`/items/${unencodedSegment("a?b")}`);
    expect(lastUrl()).toBe(`${BASE}/items/a?b&teamId=t1`);
  });
});

describe("withPagination on a root array", () => {
  it("collects the response itself when the key is null", async () => {
    fetchMock
      .mockResolvedValueOnce(response([{ cursor: "c", thing: { id: 1, name: "a" } }]))
      .mockResolvedValueOnce(response([]));
    const api = withPagination(client(), { pageParam: "limit", sizeParam: "cursor", pageSize: 1 });
    await expect(api.getAll("/root-array", null)).resolves.toHaveLength(1);
  });
});

describe("withCursorPagination", () => {
  const item = (id: number): Item => ({ id, name: `i${id}` });
  const urls = () => fetchMock.mock.calls.map(([url]) => String(url).replace(BASE, ""));
  /** Answer each request with the next body; a test that asks for more has failed. */
  const answer = (...bodies: unknown[]) => {
    for (const body of bodies) fetchMock.mockResolvedValueOnce(response(body));
    fetchMock.mockRejectedValue(new Error("asked for a page nothing said existed"));
  };

  const nested = (extra: { maxPages?: number } = {}) =>
    withCursorPagination(client(), {
      cursorParam: "until",
      sizeParam: "limit",
      pageSize: 2,
      maxPages: extra.maxPages ?? 10,
      next: "pagination.next",
    });

  describe("a cursor in a nested response field", () => {
    it("omits the cursor on the first page and appends it after the caller's query", async () => {
      answer(
        { things: [item(1), item(2)], pagination: { next: 1700 } },
        { things: [item(3)], pagination: { next: null } },
      );
      const all = await nested().getAll("/nested", "things", { query: { sort: "name" } });
      expect(all.map((thing) => thing.id)).toEqual([1, 2, 3]);
      expect(urls()).toEqual(["/nested?sort=name&limit=2", "/nested?sort=name&limit=2&until=1700"]);
    });

    it("reads a cursor on one member of a union response", async () => {
      answer(
        { things: [item(1)], pagination: { next: "tok en" } },
        { things: [item(2)], pagination: null },
      );
      await expect(nested().getAll("/union", "things")).resolves.toHaveLength(2);
      expect(urls()[1]).toBe("/union?limit=2&until=tok+en");
    });

    it.each([
      ["null", { things: [item(1)], pagination: { next: null } }],
      ["zero", { things: [item(1)], pagination: { next: 0 } }],
      ["an empty string", { things: [item(1)], pagination: { next: "" } }],
      ["undefined", { things: [item(1)], pagination: {} }],
      ["a missing parent", { things: [item(1)] }],
      ["a parent that is not an object", { things: [item(1)], pagination: "x" }],
    ])("ends when the cursor is %s", async (_name, body) => {
      answer(body);
      await expect(nested().getAll("/nested", "things")).resolves.toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["empty", { things: [], pagination: { next: 5 } }],
      ["missing", { pagination: { next: 5 } }],
      ["not an array", { things: "nope", pagination: { next: 5 } }],
    ])("ends when the batch is %s, even with a cursor", async (_name, body) => {
      answer(body);
      await expect(nested().getAll("/nested", "things")).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("takes pageSize and maxPages per call", async () => {
      answer(
        { things: [item(1)], pagination: { next: 1 } },
        { things: [item(2)], pagination: { next: 2 } },
      );
      const all = await nested().getAll("/nested", "things", { pageSize: 9, maxPages: 2 });
      expect(all).toHaveLength(2);
      expect(urls()).toEqual(["/nested?limit=9", "/nested?limit=9&until=1"]);
    });

    it("keeps the client's other verbs, and propagates a failed page", async () => {
      fetchMock.mockResolvedValueOnce(response({}));
      await nested().get("/single");
      expect(lastUrl()).toBe(`${BASE}/single`);
      fetchMock
        .mockResolvedValueOnce(response({ things: [item(1)], pagination: { next: 8 } }))
        .mockResolvedValueOnce(new Response("nope", { status: 500 }));
      await expect(nested().getAll("/nested", "things")).rejects.toThrow(
        "for /nested?limit=2&until=8: nope",
      );
    });
  });

  describe("termination", () => {
    it("stops at maxPages on a repeating cursor, returning what it has", async () => {
      fetchMock.mockImplementation(async () =>
        response({ things: [item(1)], pagination: { next: 7 } }),
      );
      const all = await nested({ maxPages: 5 }).getAll("/nested", "things");
      expect(all).toHaveLength(5);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("reports a list cut off at maxPages, and only then", async () => {
      fetchMock.mockImplementation(async () =>
        response({ things: [item(1)], pagination: { next: 7 } }),
      );
      const onTruncated = vi.fn();
      const api = withCursorPagination(client(), {
        cursorParam: "until",
        maxPages: 3,
        next: "pagination.next",
        onTruncated,
      });
      await api.getAll("/no-size", "things");
      expect(onTruncated).toHaveBeenCalledExactlyOnceWith({
        path: "/no-size",
        items: 3,
        maxPages: 3,
      });

      onTruncated.mockClear();
      fetchMock.mockImplementation(async () =>
        response({ things: [item(1)], pagination: { next: null } }),
      );
      await api.getAll("/no-size", "things");
      expect(onTruncated).not.toHaveBeenCalled();
    });

    it("stops on a repeated cursor when told to", async () => {
      fetchMock.mockImplementation(async () =>
        response({ things: [item(1)], pagination: { next: 7 } }),
      );
      const api = withCursorPagination(client(), {
        cursorParam: "until",
        maxPages: 50,
        next: "pagination.next",
        stopOnRepeatedCursor: true,
      });
      await expect(api.getAll("/no-size", "things")).resolves.toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws on a 2xx with no body rather than reading it as an empty list", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(nested().getAll("/nested", "things")).rejects.toThrow(
        "Cannot read properties of undefined (reading 'things')",
      );
    });

    it("reads a 2xx with no body as the end of the list when told to", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const api = withCursorPagination(client(), {
        cursorParam: "until",
        maxPages: 2,
        next: "pagination.next",
        emptyBodyEndsList: true,
      });
      await expect(api.getAll("/no-size", "things")).resolves.toEqual([]);
    });
  });

  describe("a cursor on the last item", () => {
    const lastItem = () =>
      withCursorPagination(client(), {
        cursorParam: "after",
        sizeParam: "limit",
        pageSize: 2,
        maxPages: 10,
        next: { lastItem: "id" },
        hasMore: "has_more",
      });

    it("sends the last item's field while the provider says there is more", async () => {
      answer(
        { data: [item(1), item(2)], has_more: true, other: [] },
        { data: [item(3)], has_more: false, other: [] },
      );
      await expect(lastItem().getAll("/last-item", "data")).resolves.toHaveLength(3);
      expect(urls()).toEqual(["/last-item?limit=2", "/last-item?limit=2&after=2"]);
    });

    it("ends on has_more false without asking again", async () => {
      answer({ data: [item(1), item(2)], has_more: false, other: [] });
      await expect(lastItem().getAll("/last-item", "data")).resolves.toHaveLength(2);
    });

    it("ends when has_more is true but the page is empty", async () => {
      answer({ data: [], has_more: true, other: [] });
      await expect(lastItem().getAll("/last-item", "data")).resolves.toEqual([]);
    });
  });

  describe("a root array with a cursor on each row, ending on a short page", () => {
    const api = () =>
      withCursorPagination(client(), {
        cursorParam: "cursor",
        sizeParam: "limit",
        pageSize: 2,
        maxPages: 10,
        next: { lastItem: "cursor" },
        stopOnShortPage: true,
        stopOnRepeatedCursor: true,
      });

    it("collects the rows", async () => {
      const row = (id: number) => ({ cursor: `c${id}`, thing: item(id) });
      answer([row(1), row(2)], [row(3)]);
      const rows = await api().getAll("/root-array", null);
      expect(rows.map((r) => r.thing.id)).toEqual([1, 2, 3]);
      expect(urls()).toEqual(["/root-array?limit=2", "/root-array?limit=2&cursor=c2"]);
    });

    it("does not rely on the short page when the cursor repeats", async () => {
      const row = (id: number) => ({ cursor: "same", thing: item(id) });
      fetchMock.mockImplementation(async () => response([row(1), row(2)]));
      await expect(api().getAll("/root-array", null)).resolves.toHaveLength(4);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("a token that may come back with an empty page", () => {
    const tokens = (continueOnEmptyPage: boolean) =>
      withCursorPagination(client(), {
        cursorParam: "pageToken",
        sizeParam: "pageSize",
        pageSize: 100,
        maxPages: 10,
        next: "nextPageToken",
        continueOnEmptyPage,
      });

    it("keeps following it when told to", async () => {
      answer({ nextPageToken: "a" }, { things: [item(1)], nextPageToken: "" });
      await expect(tokens(true).getAll("/token", "things")).resolves.toHaveLength(1);
      expect(urls()[1]).toBe("/token?pageSize=100&pageToken=a");
    });

    it("stops by default", async () => {
      answer({ nextPageToken: "a" });
      await expect(tokens(false).getAll("/token", "things")).resolves.toEqual([]);
    });
  });

  it("pulls a cursor out of a link, ending when nothing can be read from it", async () => {
    answer(
      { data: [item(1)], links: { next: "/link?page%5Bafter%5D=abc" } },
      { data: [item(2)], links: { next: "/link" } },
    );
    const api = withCursorPagination(client(), {
      cursorParam: "page[after]",
      sizeParam: "page[size]",
      pageSize: 100,
      maxPages: 10,
      next: "links.next",
      readCursor: (link) => new URL(link, BASE).searchParams.get("page[after]"),
    });
    await expect(api.getAll("/link", "data")).resolves.toHaveLength(2);
    expect(urls()[1]).toBe("/link?page%5Bsize%5D=100&page%5Bafter%5D=abc");
  });

  it("sends no page size for a provider that takes none", async () => {
    answer({ things: [item(1)], pagination: { next: 3 } }, { things: [], pagination: {} });
    const api = withCursorPagination(client(), {
      cursorParam: "until",
      maxPages: 5,
      next: "pagination.next",
    });
    await api.getAll("/no-size", "things");
    expect(urls()).toEqual(["/no-size", "/no-size?until=3"]);
  });

  it("forwards an abort signal", async () => {
    answer({ things: [], pagination: { next: null } });
    const { signal } = new AbortController();
    await nested().getAll("/nested", "things", { signal });
    expect(lastInit()?.signal).toBe(signal);
  });
});

/**
 * Checked by `tsc`, never run. Each directive fails the type check if the line
 * below it starts compiling, so these are what stops the client going loose.
 */
export function compileTimeChecks(api: ApiClient<paths>, raw: string) {
  const id = pathEncode(1);
  const paged = withPagination(api, { pageParam: "page", sizeParam: "per_page", pageSize: 2 });

  // An unlisted path, and a listed path with a verb it does not have.
  // @ts-expect-error
  void api.get("/not-listed");
  // @ts-expect-error
  void api.put("/items");

  // A path parameter that did not go through pathEncode.
  // @ts-expect-error
  void api.get(`/items/${raw}`);
  void api.get(`/items/${id}`);

  // A wrong query key, a wrong query value, and a query on an operation with none.
  // @ts-expect-error
  void api.get("/items", { query: { pagee: 1 } });
  // @ts-expect-error
  void api.get("/items", { query: { sort: "created" } });
  // @ts-expect-error
  void api.get("/single", { query: { page: 1 } });

  // A required query cannot be left out, nor one of its required keys.
  // @ts-expect-error
  void api.get(`/items/${id}/metrics`);
  // @ts-expect-error
  void api.get(`/items/${id}/metrics`, { query: { type: ["cpu"] } });
  // @ts-expect-error
  void api.get(`/items/${id}/metrics`, { query: { type: commaSeparated(["ram"]), start: "x" } });
  void api.get(`/items/${id}/metrics`, { query: { type: commaSeparated(["cpu"]), start: "x" } });

  // A missing body, a missing required key, a wrong type, an unknown key.
  // @ts-expect-error
  void api.post("/items");
  // @ts-expect-error
  void api.post("/items", { body: { size: 1 } });
  // @ts-expect-error
  void api.post("/items", { body: { name: 1 } });
  // @ts-expect-error
  void api.post("/items", { body: { name: "n", kind: "c" } });
  // @ts-expect-error
  void api.post("/items", { body: { name: "n", nope: true } });
  // `undefined` for a required key is allowed, since it means "let the provider say so".
  const fromForm: string | undefined = raw;
  void api.post("/items", { body: { name: fromForm } });

  // An optional body may be left out, but is still checked when present.
  void api.patch(`/items/${id}`);
  // @ts-expect-error
  void api.patch(`/items/${id}`, { body: { name: 1 } });

  // Responses are typed: a 2xx body, or `undefined` when there is none.
  void (async () => {
    const { item } = await api.get(`/items/${id}`);
    const name: string = item.name;
    // @ts-expect-error
    const nope = item.nope;
    const gone: undefined = await api.delete(`/items/${id}`);
    return { name, nope, gone };
  });

  // The root key is checked against the response, and only array fields qualify.
  // @ts-expect-error
  void paged.getAll("/items", "itms");
  // @ts-expect-error
  void paged.getAll("/items", "meta");
  // @ts-expect-error
  void paged.getAll("/single", "detail");
  // The helper owns the page parameters, but the rest of the query is still checked.
  // @ts-expect-error
  void paged.getAll("/items", "items", { query: { page: 2 } });
  // @ts-expect-error
  void paged.getAll("/items", "items", { query: { nope: 2 } });

  // The item type comes from the response, with no generic at the call site.
  void (async () => {
    const all = await paged.getAll("/items", "items", { query: { sort: "name" } });
    const name: string | undefined = all[0]?.name;
    // @ts-expect-error
    const nope = all[0]?.nope;
    return { name, nope };
  });

  const base = {
    cursorParam: "until",
    sizeParam: "limit",
    pageSize: 2,
    maxPages: 2,
    next: "pagination.next",
  } as const;
  const cursors = withCursorPagination(api, base);

  // A configuration no operation in the document fits does not compile: a misspelt
  // cursor field, one that is not a cursor, a query parameter nothing takes, a last
  // item field nothing has, and a `hasMore` that is missing or is not a flag.
  // @ts-expect-error
  void withCursorPagination(api, { ...base, next: "paginaton.next" });
  // @ts-expect-error
  void withCursorPagination(api, { ...base, next: "pagination.nxt" });
  // @ts-expect-error
  void withCursorPagination(api, { ...base, next: "pagination" });
  // @ts-expect-error
  void withCursorPagination(api, { ...base, cursorParam: "untl" });
  // @ts-expect-error
  void withCursorPagination(api, { ...base, sizeParam: "limt" });
  // @ts-expect-error
  void withCursorPagination(api, { ...base, next: { lastItem: "nope" } });
  void withCursorPagination(api, {
    ...base,
    cursorParam: "after",
    // @ts-expect-error
    next: { lastItem: "name.first" },
  });
  // @ts-expect-error
  void withCursorPagination(api, { ...base, hasMore: "has_mor" });
  void withCursorPagination(api, {
    ...base,
    cursorParam: "after",
    // @ts-expect-error
    next: { lastItem: "id" },
    hasMore: "other",
  });

  // `getAll` only takes operations the configuration fits: one with no such cursor
  // parameter, no such size parameter, no such field, a cursor that is an object,
  // a route with no query at all, and a route that does not exist.
  // @ts-expect-error
  void cursors.getAll("/no-cursor-param", "things");
  // @ts-expect-error
  void cursors.getAll("/no-size", "things");
  // @ts-expect-error
  void cursors.getAll("/no-cursor-field", "things");
  // @ts-expect-error
  void cursors.getAll("/object-cursor", "things");
  // @ts-expect-error
  void cursors.getAll("/single", "detail");
  // @ts-expect-error
  void cursors.getAll("/not-listed", "things");
  void cursors.getAll("/nested", "things");
  void cursors.getAll("/union", "things");
  void cursors.getAll("/nullable", "things");

  // The list key is checked against the response, and only arrays qualify.
  // @ts-expect-error
  void cursors.getAll("/nested", "thngs");
  // @ts-expect-error
  void cursors.getAll("/nested", "pagination");
  // @ts-expect-error
  void cursors.getAll("/nested", null);

  // The paging parameters belong to the helper; the rest of the query is checked.
  // @ts-expect-error
  void cursors.getAll("/nested", "things", { query: { until: 1 } });
  // @ts-expect-error
  void cursors.getAll("/nested", "things", { query: { limit: 1 } });
  // @ts-expect-error
  void cursors.getAll("/nested", "things", { query: { sort: "nope" } });
  void cursors.getAll("/nested", "things", { query: { sort: "name" } });

  // A last-item cursor is read from the list named, so `other`, whose items have no
  // `id`, is refused while `data` is not.
  const lastItem = withCursorPagination(api, {
    cursorParam: "after",
    sizeParam: "limit",
    maxPages: 2,
    next: { lastItem: "id" },
    hasMore: "has_more",
  });
  // @ts-expect-error
  void lastItem.getAll("/last-item", "other");
  void lastItem.getAll("/last-item", "data");

  // A root array is collected with `null`, and only there.
  const rootArray = withCursorPagination(api, {
    cursorParam: "cursor",
    sizeParam: "limit",
    maxPages: 2,
    next: { lastItem: "cursor" },
  });
  // @ts-expect-error
  void rootArray.getAll("/root-array", "thing");

  // Items come from the response, with no generic at the call site, across a union
  // and a nullable response alike.
  void (async () => {
    const nestedName: string | undefined = (await cursors.getAll("/nested", "things"))[0]?.name;
    const unionName: string | undefined = (await cursors.getAll("/union", "things"))[0]?.name;
    const nullableId: number | undefined = (await cursors.getAll("/nullable", "things"))[0]?.id;
    const row = (await rootArray.getAll("/root-array", null))[0];
    const thing: Item | undefined = row?.thing;
    const named: ApiListItem<paths["/nested"]["get"], "things"> = { id: 1, name: "n" };
    // @ts-expect-error
    const nope = (await cursors.getAll("/nested", "things"))[0]?.nope;
    return { nestedName, unionName, nullableId, thing, named, nope };
  });
}

/** Named response types come from the same place the verbs get them. */
export type ItemResponse = ApiResponse<paths["/items/{id}"]["get"]>["item"];
