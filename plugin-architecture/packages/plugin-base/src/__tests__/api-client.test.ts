import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  commaSeparated,
  createApiClient,
  pathEncode,
  withPagination,
  type ApiClient,
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

interface paths {
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
}

/** Named response types come from the same place the verbs get them. */
export type ItemResponse = ApiResponse<paths["/items/{id}"]["get"]>["item"];
