import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  commaSeparated,
  createApiClient,
  nextLinkHeader,
  parseLinkHeader,
  pathEncode,
  unencodedSegment,
  withCursorPagination,
  withLinkPagination,
  withPagination,
  type ApiClient,
  type ApiFailure,
  type ApiForm,
  type ApiListItem,
  type ApiResponse,
  type PageAnswer,
} from "../api-client.js";
import {
  isIncompleteListError,
  ListPageError,
  ListTruncatedError,
  requireListPage,
  rethrowIncompleteList,
  withinListCap,
} from "../list-errors.js";
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
  // The shapes `withLinkPagination` has to read.
  "/apps": Get<{ limit?: number; q?: string }, Item[]>;
  "/twilio": Get<{ PageSize?: number }, { calls: Item[]; next_page_uri?: string | null }>;
  "/meta-link": Get<
    { PageSize?: number },
    { rows: Item[]; meta: { next_page_url: string | null } }
  >;
  "/no-link-field": Get<{ PageSize?: number }, { rows: Item[] }>;
  // A list whose only parameter is its size, and one that requires another.
  "/size-only": Get<{ PageSize?: number }, { rows: Item[]; next_page_uri?: string | null }>;
  "/offset": Get<{ offset?: number; limit?: number }, { rows: Item[] }>;
  "/required-filter": {
    get: {
      parameters: { query: { project: string; PageSize?: number } };
      requestBody?: never;
      responses: { 200: Json<{ rows: Item[]; next_page_uri?: string | null }> };
    };
    put?: never;
    post?: never;
    delete?: never;
    patch?: never;
  };
  // Request and response encodings other than plain JSON.
  "/form": {
    get?: never;
    put?: never;
    post: {
      parameters: { query?: never };
      requestBody?: {
        content: {
          "application/x-www-form-urlencoded": {
            Name: string;
            Sticky?: boolean;
            Size?: number;
            Tag?: string[];
            Limits?: { max?: number; labels?: string[] };
          };
        };
      };
      responses: { 201: Json<{ item: Item }> };
    };
    delete?: never;
    patch?: never;
  };
  "/form-required": {
    get?: never;
    put?: never;
    post: {
      parameters: { query?: never };
      requestBody: { content: { "application/x-www-form-urlencoded": { Name: string } } };
      responses: { 204: NoContent };
    };
    delete?: never;
    patch?: never;
  };
  "/either": {
    get?: never;
    put?: never;
    post: {
      parameters: { query?: never };
      requestBody: {
        content: {
          "application/json": { asJson: string };
          "application/x-www-form-urlencoded": { asForm: string };
        };
      };
      responses: { 204: NoContent };
    };
    delete?: never;
    patch?: never;
  };
  "/upload": {
    get?: never;
    put?: never;
    post: {
      parameters: { query?: never };
      requestBody: { content: { "multipart/form-data": { file: string } } };
      responses: { 200: Json<{ item: Item }> };
    };
    delete?: never;
    patch: {
      parameters: { query?: never };
      requestBody?: { content: { "application/octet-stream": string } };
      responses: { 204: NoContent };
    };
  };
  "/vendor-json": {
    get: {
      parameters: { query?: never };
      requestBody?: never;
      responses: { 200: { content: { "application/vnd.acme.v2+json": { acme: string } } } };
    };
    put: {
      parameters: { query?: never };
      requestBody: { content: { "application/merge-patch+json": { acme?: string } } };
      responses: { 200: { content: { "application/json; charset=utf-8": { charset: string } } } };
    };
    post: {
      parameters: { query?: never };
      requestBody?: never;
      responses: {
        200: {
          content: {
            "application/json": { plain: string };
            "application/vnd.acme.v2+json": { acme: string };
            "text/plain": string;
          };
        };
      };
    };
    delete?: never;
    patch?: never;
  };
  "/not-json": {
    get: {
      parameters: { query?: never };
      requestBody?: never;
      responses: {
        200: { content: { "text/csv": string; "application/x-ndjson": string } };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    patch?: never;
  };
  "/odd-codes": {
    get: {
      parameters: { query?: never };
      requestBody?: never;
      responses: {
        206: Json<{ partial: true }>;
        207: Json<{ multi: true }>;
        "2XX": Json<{ wild: true }>;
        301: Json<{ moved: true }>;
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    patch?: never;
  };
  "/no-query": {
    get: {
      parameters: { query?: never };
      requestBody?: never;
      responses: { 200: Json<Item[]> };
    };
    put?: never;
    post?: never;
    delete?: never;
    patch?: never;
  };
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

  it("sends a nested object as bracketed names, which URLSearchParams would escape", async () => {
    const api = createApiClient<{
      "/nested-query": Get<
        { created?: { gte?: number; lt?: number | undefined; tag?: string[] } },
        object
      >;
    }>({ vendor: "E", baseUrl: BASE, headers: {} });
    await api.get("/nested-query", {
      query: { created: { gte: 1, lt: undefined, tag: ["a b", "c"] } },
    });
    const expected = new URLSearchParams();
    expected.append("created[gte]", "1");
    expected.append("created[tag]", "a b");
    expected.append("created[tag]", "c");
    expect(lastUrl()).toBe(`${BASE}/nested-query?${expected}`);
  });

  it("takes a serializer for a dialect the default does not speak, scope following it", async () => {
    const api = createApiClient<paths>({
      vendor: "E",
      baseUrl: BASE,
      headers: {},
      scopeQuery: { team: "t" },
      serializeQuery: (query) =>
        Object.entries(query)
          .flatMap(([key, value]) =>
            Array.isArray(value) ? value.map((v, i) => `${key}[${i}]=${String(v)}`) : [],
          )
          .join("&"),
    });
    await api.get("/items", { query: { tag: ["a", "b"] } });
    expect(lastUrl()).toBe(`${BASE}/items?tag[0]=a&tag[1]=b&team=t`);
    await api.get("/items", { query: { page: 1 } });
    expect(lastUrl()).toBe(`${BASE}/items?team=t`);
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

describe("form bodies", () => {
  const FORM = "application/x-www-form-urlencoded";

  it("sends the form type and URLSearchParams' bytes", async () => {
    fetchMock.mockResolvedValueOnce(response({ item: { id: 1, name: "n" } }, 201));
    const { item } = await client().post("/form", {
      form: { Name: "a b&c=d+e/é", Sticky: false, Size: 0 },
    });
    expect(item.id).toBe(1);
    expect(lastInit()?.method).toBe("POST");
    expect(lastInit()?.body).toBe(
      new URLSearchParams({ Name: "a b&c=d+e/é", Sticky: "false", Size: "0" }).toString(),
    );
    expect(lastInit()?.headers).toMatchObject({ "Content-Type": FORM });
  });

  it("repeats a key for an array, brackets a nested object, and skips what is absent", async () => {
    await client().post("/form", {
      form: {
        Name: "",
        Sticky: undefined,
        Tag: ["x y", "z"],
        Limits: { max: 3, labels: ["l"] },
      },
    });
    expect(lastInit()?.body).toBe("Name=&Tag=x+y&Tag=z&Limits%5Bmax%5D=3&Limits%5Blabels%5D=l");
    await client().post("/form", { form: { Name: "n", Tag: commaSeparated(["a", "b c"]) } });
    expect(lastInit()?.body).toBe("Name=n&Tag=a,b+c");
  });

  it("sends an empty body, with its type, for an empty form", async () => {
    const name: string | undefined = undefined;
    await client().post("/form", { form: { Name: name } });
    expect(lastInit()?.body).toBe("");
    expect(lastInit()?.headers).toMatchObject({ "Content-Type": FORM });
  });

  it("sends no body and no form type when an optional form is left out", async () => {
    const api = createApiClient<paths>({
      vendor: "E",
      baseUrl: BASE,
      headers: {},
      contentType: "with-body",
    });
    await api.post("/form");
    expect(lastInit()?.body).toBeUndefined();
    expect(lastInit()?.headers).toEqual({});
  });

  it("puts the type last with-body and first otherwise, and leaves the caller's alone", async () => {
    const options = { vendor: "E", baseUrl: BASE, headers: { Accept: "application/json" } };
    await createApiClient<paths>({ ...options, contentType: "with-body" }).post("/form", {
      form: { Name: "n" },
    });
    expect(Object.entries(lastInit()?.headers ?? {})).toEqual([
      ["Accept", "application/json"],
      ["Content-Type", FORM],
    ]);
    await createApiClient<paths>(options).post("/form", { form: { Name: "n" } });
    expect(Object.keys(lastInit()?.headers ?? {})).toEqual(["Content-Type", "Accept"]);
    await createApiClient<paths>({
      ...options,
      headers: { "Content-Type": `${FORM}; charset=utf-8` },
    }).post("/form", { form: { Name: "n" } });
    expect(lastInit()?.headers).toEqual({ "Content-Type": `${FORM}; charset=utf-8` });
  });

  it("stays form-encoded whatever the query's encoder does", async () => {
    const api = createApiClient<paths>({
      vendor: "E",
      baseUrl: BASE,
      headers: {},
      encodeQuery: encodeURIComponent,
    });
    await api.post("/form", { form: { Name: "a b" } });
    expect(lastInit()?.body).toBe("Name=a+b");
  });

  it("takes a serializer for a dialect the default does not speak", async () => {
    const api = createApiClient<paths>({
      vendor: "E",
      baseUrl: BASE,
      headers: {},
      serializeForm: (form) => `keys=${Object.keys(form).join(",")}`,
    });
    await api.post("/form", { form: { Name: "n", Size: 1 } });
    expect(lastInit()?.body).toBe("keys=Name,Size");
  });

  it("goes through the host's http service as a string, with its type", async () => {
    const { http, calls } = fakeHost([{ status: 204 }]);
    const api = createApiClient<paths>({
      vendor: "E",
      baseUrl: BASE,
      headers: { Accept: "application/json" },
      http,
      contentType: "with-body",
    });
    await api.post("/form-required", { form: { Name: "a b" } });
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: "Name=a+b",
      headers: { Accept: "application/json", "Content-Type": FORM },
    });
  });

  it("picks the encoding by which key the call used, where the document has both", async () => {
    await client().post("/either", { form: { asForm: "x" } });
    expect(lastInit()?.body).toBe("asForm=x");
    expect(lastInit()?.headers).toMatchObject({ "Content-Type": FORM });
    await client().post("/either", { body: { asJson: "x" } });
    expect(lastInit()?.body).toBe('{"asJson":"x"}');
    expect(lastInit()?.headers).toMatchObject({ "Content-Type": "application/json" });
  });
});

describe("headers on one call", () => {
  it("merge over the client's, and reach every page of a walk", async () => {
    const api = createApiClient<paths>({
      vendor: "E",
      baseUrl: BASE,
      headers: { Accept: "application/json", Authorization: "Bearer t" },
    });
    await api.get("/items", {
      headers: { Accept: "application/vnd.acme.v2+json", "If-Match": "e" },
    });
    expect(lastInit()?.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/vnd.acme.v2+json",
      Authorization: "Bearer t",
      "If-Match": "e",
    });

    fetchMock
      .mockResolvedValueOnce(response({ calls: [{ id: 1 }], next_page_uri: "/more" }))
      .mockResolvedValueOnce(response({ calls: [{ id: 2 }], next_page_uri: null }));
    const links = withLinkPagination(api, {
      next: "next_page_uri",
      maxPages: 5,
      foreignLinks: "follow",
    });
    fetchMock.mockClear();
    await links.getAll("/twilio", "calls", { headers: { "If-Match": "x" } });
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "If-Match": "x" }),
      expect.objectContaining({ "If-Match": "x" }),
    ]);
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(response({ items: [{ id: 1 }] }))
      .mockResolvedValueOnce(response({ items: [] }));
    const numbered = withPagination(api, { pageParam: "page", sizeParam: "per_page", pageSize: 1 });
    await numbered.getAll("/items", "items", { headers: { "If-Match": "y" } });
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "If-Match": "y" }),
      expect.objectContaining({ "If-Match": "y" }),
    ]);
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

  it("refuses a page with no list, rather than read it as the end of the list", async () => {
    fetchMock.mockResolvedValueOnce(response({ meta: {} }));
    await expect(paged().getAll("/items", "items")).rejects.toThrow(ListPageError);
  });

  it("refuses a bad second page too, instead of returning the first", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ items: items(2) }))
      .mockResolvedValueOnce(response({ error: "try again" }));
    await expect(paged().getAll("/items", "items")).rejects.toThrow(
      'Example answered /items with a page that is not a list: it has no "items", only an object with error.',
    );
  });

  it("reads a missing key as empty only when told to", async () => {
    fetchMock.mockResolvedValueOnce(response({ meta: {} }));
    const api = withPagination(client(), {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: 2,
      missingListIsEmpty: true,
    });
    await expect(api.getAll("/items", "items")).resolves.toEqual([]);
  });

  it("throws at its page cap with a page still full, and only then", async () => {
    fetchMock.mockImplementation(async () => response({ items: items(2) }));
    const capped = withPagination(client(), {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: 2,
      maxPages: 3,
    });
    await expect(capped.getAll("/items", "items")).rejects.toThrow("stopped at 3 pages (6 items)");
    await expect(capped.getAll("/items", "items", { partial: true })).resolves.toHaveLength(6);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(response({ items: items(2) }))
      .mockResolvedValueOnce(response({ items: items(2) }))
      .mockResolvedValueOnce(response({ items: items(1) }));
    await expect(capped.getAll("/items", "items")).resolves.toHaveLength(5);
  });

  it("has a cap of its own, so a provider ignoring the page number cannot loop forever", async () => {
    fetchMock.mockImplementation(async () => response({ items: items(2) }));
    const unbounded = withPagination(client(), {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: 2,
    });
    await expect(unbounded.getAll("/items", "items")).rejects.toThrow("stopped at 1000 pages");
  });

  it("reads no body as the end only when told to", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(paged().getAll("/items", "items")).rejects.toThrow(ListPageError);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = withPagination(client(), {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: 2,
      emptyBodyEndsList: true,
    });
    await expect(api.getAll("/items", "items")).resolves.toEqual([]);
  });

  it("sends the size before the page number when told to", async () => {
    fetchMock.mockResolvedValueOnce(response({ items: [] }));
    const api = withPagination(client(), {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: 2,
      sizeFirst: true,
    });
    await api.getAll("/items", "items");
    expect(urls()).toEqual(["/items?per_page=2&page=1"]);
  });

  it("takes pageSize and stopWhen per call", async () => {
    fetchMock.mockImplementation(async () => response({ items: items(9) }));
    await paged().getAll("/items", "items", { pageSize: 9, stopWhen: () => true });
    expect(urls()).toEqual(["/items?page=1&per_page=9"]);
  });

  it("sends the page params first when told to", async () => {
    fetchMock.mockResolvedValueOnce(response({ items: [] }));
    const api = withPagination(client(), {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: 2,
      pagingFirst: true,
    });
    await api.getAll("/items", "items", { query: { sort: "name" } });
    expect(urls()).toEqual(["/items?page=1&per_page=2&sort=name"]);
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

    it("ends when the batch is empty, even with a cursor", async () => {
      answer({ things: [], pagination: { next: 5 } });
      await expect(nested().getAll("/nested", "things")).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "missing",
        { pagination: { next: 5 } },
        'it has no "things", only an object with pagination',
      ],
      ["null", { things: null, pagination: { next: 5 } }, 'its "things" was null'],
      ["not an array", { things: "nope", pagination: { next: 5 } }, 'its "things" was a string'],
      ["an object", { things: {}, pagination: { next: 5 } }, 'its "things" was an empty object'],
    ])("refuses a batch that is %s", async (_name, body, said) => {
      answer(body);
      const failure = nested().getAll("/nested", "things");
      await expect(failure).rejects.toBeInstanceOf(ListPageError);
      await expect(failure).rejects.toThrow(said);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("loses what a good first page read when the next one is bad", async () => {
      answer({ things: [item(1)], pagination: { next: 5 } }, { error: "nope" });
      await expect(nested().getAll("/nested", "things")).rejects.toThrow(
        'it has no "things", only an object with error',
      );
    });

    it("refuses a root list answered with an object", async () => {
      answer({ message: "maintenance" });
      const api = withCursorPagination(client(), {
        cursorParam: "cursor",
        sizeParam: "limit",
        pageSize: 2,
        maxPages: 2,
        next: { lastItem: "cursor" },
      });
      await expect(api.getAll("/root-array", null)).rejects.toThrow(
        "it was an object with message",
      );
    });

    it("still refuses something that is there and not a list, whatever it is told", async () => {
      answer({ things: "nope", pagination: { next: 5 } });
      const api = withCursorPagination(client(), {
        cursorParam: "until",
        maxPages: 2,
        next: "pagination.next",
        missingListIsEmpty: true,
        emptyBodyEndsList: true,
      });
      await expect(api.getAll("/no-size", "things")).rejects.toThrow(ListPageError);
    });

    it("ends on a total it is told about, without asking for another page", async () => {
      answer({ things: [item(1)], pagination: { next: 5 }, count: 1 });
      const api = withCursorPagination(client(), {
        cursorParam: "until",
        maxPages: 5,
        next: "pagination.next",
        total: "count",
      });
      await expect(api.getAll("/no-size", "things")).resolves.toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("takes pageSize and maxPages per call", async () => {
      answer(
        { things: [item(1)], pagination: { next: 1 } },
        { things: [item(2)], pagination: { next: 2 } },
      );
      const all = await nested().getAll("/nested", "things", {
        pageSize: 9,
        maxPages: 2,
        partial: true,
      });
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
    it("throws at maxPages with more to read, naming the path, the count and the cap", async () => {
      fetchMock.mockImplementation(async () =>
        response({ things: [item(1), item(2)], pagination: { next: 7 } }),
      );
      const failure = nested({ maxPages: 5 }).getAll("/nested", "things");
      await expect(failure).rejects.toBeInstanceOf(ListTruncatedError);
      await expect(failure).rejects.toThrow(
        "Example: /nested has more than Infrawrench reads. It stopped at 5 pages (10 items)",
      );
      await expect(failure).rejects.toMatchObject({ path: "/nested", items: 10, maxPages: 5 });
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("returns normally when the last allowed page is the last page", async () => {
      answer(
        { things: [item(1)], pagination: { next: 7 } },
        { things: [item(2)], pagination: { next: null } },
      );
      await expect(nested({ maxPages: 2 }).getAll("/nested", "things")).resolves.toHaveLength(2);
    });

    it("hands back part of a list only when a client or a call says that is fine", async () => {
      fetchMock.mockImplementation(async () =>
        response({ things: [item(1)], pagination: { next: 7 } }),
      );
      const bounded = withCursorPagination(client(), {
        cursorParam: "until",
        maxPages: 3,
        next: "pagination.next",
        partial: true,
      });
      await expect(bounded.getAll("/no-size", "things")).resolves.toHaveLength(3);
      await expect(bounded.getAll("/no-size", "things", { partial: false })).rejects.toThrow(
        ListTruncatedError,
      );

      const complete = withCursorPagination(client(), {
        cursorParam: "until",
        maxPages: 3,
        next: "pagination.next",
      });
      await expect(complete.getAll("/no-size", "things")).rejects.toThrow(ListTruncatedError);
      await expect(complete.getAll("/no-size", "things", { partial: true })).resolves.toHaveLength(
        3,
      );
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
        partial: true,
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
      await expect(nested().getAll("/nested", "things")).rejects.toThrow("it was empty");
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
    const tokens = (continueOnEmptyPage: boolean, missingListIsEmpty = true) =>
      withCursorPagination(client(), {
        cursorParam: "pageToken",
        sizeParam: "pageSize",
        pageSize: 100,
        maxPages: 10,
        next: "nextPageToken",
        continueOnEmptyPage,
        missingListIsEmpty,
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

    it("refuses an omitted list unless told a proto3 provider leaves it out", async () => {
      answer({ nextPageToken: "a" });
      await expect(tokens(true, false).getAll("/token", "things")).rejects.toThrow(ListPageError);
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

  it("sends the size and cursor first when told to", async () => {
    answer({ things: [item(1)], pagination: { next: 8 } }, { things: [], pagination: {} });
    const api = withCursorPagination(client(), {
      cursorParam: "until",
      sizeParam: "limit",
      pageSize: 2,
      maxPages: 5,
      next: "pagination.next",
      pagingFirst: true,
    });
    await api.getAll("/nested", "things", { query: { sort: "name" } });
    expect(urls()).toEqual(["/nested?limit=2&sort=name", "/nested?limit=2&until=8&sort=name"]);
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

/** A `Response` with headers, as the page walks read them. */
function paged(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : text, { status, headers });
}

/** A host HTTP service that answers from a queue, recording what it was asked. */
function fakeHost(
  answers: Array<{ status?: number; headers?: Record<string, string>; body?: string }>,
) {
  const calls: Array<Parameters<HttpHostServices["request"]>[0]> = [];
  const http: HttpHostServices = {
    request: async (req) => {
      calls.push(req);
      const next = answers.shift() ?? {};
      return { status: next.status ?? 200, headers: next.headers ?? {}, body: next.body ?? "" };
    },
  };
  return { http, calls };
}

describe("getResponse and getText", () => {
  it("hands back the status and lower-cased headers under global fetch", async () => {
    fetchMock.mockResolvedValueOnce(paged({ item: 1 }, { "X-Total": "12" }, 201));
    const answer = await client().getResponse("/single");
    expect(answer).toEqual({
      status: 201,
      headers: expect.objectContaining({ "x-total": "12" }),
      body: { item: 1 },
      url: `${BASE}/single`,
    });
  });

  it("hands back the same through the host's http service, whatever case it sends", async () => {
    const { http } = fakeHost([{ headers: { "X-Total": "12", LINK: "<x>" }, body: '{"item":1}' }]);
    const api = createApiClient<paths>({ vendor: "Example", baseUrl: BASE, headers: {}, http });
    const answer = await api.getResponse("/single");
    expect(answer.headers).toEqual({ "x-total": "12", link: "<x>" });
    expect(answer.body).toEqual({ item: 1 });
  });

  it("leaves a text body alone in both transports", async () => {
    fetchMock.mockResolvedValueOnce(paged('{"looks":"like json"}'));
    expect((await client().getText("/single")).body).toBe('{"looks":"like json"}');
    const { http } = fakeHost([{ body: "<html>not json" }]);
    const api = createApiClient<paths>({ vendor: "Example", baseUrl: BASE, headers: {}, http });
    expect((await api.getText("/single")).body).toBe("<html>not json");
  });

  it("takes a query, and still reports a failure", async () => {
    fetchMock.mockResolvedValueOnce(paged("nope", {}, 500));
    await expect(client().getText("/items", { query: { page: 1 } })).rejects.toThrow(
      "Example API error 500 for /items?page=1: nope",
    );
  });
});

describe("httpError", () => {
  class TeapotError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  const options = {
    vendor: "Example",
    baseUrl: BASE,
    headers: {},
    httpError: ({ status, method, path, target, url, body }: ApiFailure) =>
      new TeapotError(status, `${status} ${method} ${path} ${target} ${url} ${body}`),
  };

  it("builds what a non-2xx throws under global fetch", async () => {
    fetchMock.mockResolvedValueOnce(paged("boom", {}, 418));
    const err = await createApiClient<paths>(options)
      .get("/items", { query: { page: 2 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeapotError);
    expect(err).toMatchObject({
      status: 418,
      message: `418 GET /items /items?page=2 ${BASE}/items?page=2 boom`,
    });
  });

  it("builds what a non-2xx throws through the host's http service", async () => {
    const { http } = fakeHost([{ status: 418, body: "boom" }]);
    await expect(
      createApiClient<paths>({ ...options, http }).post("/items", { body: { name: "n" } }),
    ).rejects.toMatchObject({ status: 418, message: expect.stringContaining("418 POST /items") });
  });

  it("names a followed link by its pathname", async () => {
    fetchMock
      .mockResolvedValueOnce(paged([{ id: 1 }], { Link: '<https://x.test/a/b?c=1>; rel="next"' }))
      .mockResolvedValueOnce(paged("boom", {}, 500));
    const api = withLinkPagination(createApiClient<paths>(options), {
      next: nextLinkHeader(),
      maxPages: 5,
      foreignLinks: "follow",
    });
    await expect(api.getAll("/apps", null)).rejects.toMatchObject({
      message: "500 GET /a/b /a/b?c=1 https://x.test/a/b?c=1 boom",
    });
  });
});

describe("contentType and emptyBodyIsUndefined", () => {
  const options = { vendor: "Example", baseUrl: BASE, headers: { Accept: "application/json" } };

  it("sends Content-Type first on everything by default", async () => {
    await createApiClient<paths>(options).get("/single");
    expect(Object.keys(lastInit()?.headers ?? {})).toEqual(["Content-Type", "Accept"]);
  });

  it("sends it last and only with a body when told to", async () => {
    const api = createApiClient<paths>({ ...options, contentType: "with-body" });
    await api.get("/single");
    expect(Object.keys(lastInit()?.headers ?? {})).toEqual(["Accept"]);
    await api.post("/items", { body: { name: "n" } });
    expect(Object.keys(lastInit()?.headers ?? {})).toEqual(["Accept", "Content-Type"]);
  });

  it("does not overrule a Content-Type the caller set, in any case", async () => {
    const api = createApiClient<paths>({
      ...options,
      headers: { "content-type": "application/vnd.api+json" },
      contentType: "with-body",
    });
    await api.post("/items", { body: { name: "n" } });
    expect(lastInit()?.headers).toEqual({ "content-type": "application/vnd.api+json" });
  });

  it("throws on an empty 2xx under global fetch by default, and reads it as nothing if told", async () => {
    fetchMock.mockResolvedValueOnce(paged(""));
    await expect(createApiClient<paths>(options).get("/single")).rejects.toThrow(SyntaxError);
    fetchMock.mockResolvedValueOnce(paged(""));
    const lenient = createApiClient<paths>({ ...options, emptyBodyIsUndefined: true });
    expect(await lenient.get("/single")).toBeUndefined();
  });

  it("still reads a body as JSON with emptyBodyIsUndefined", async () => {
    fetchMock.mockResolvedValueOnce(paged({ detail: { name: "n" } }));
    const lenient = createApiClient<paths>({ ...options, emptyBodyIsUndefined: true });
    expect(await lenient.get("/single")).toEqual({ detail: { name: "n" } });
  });
});

describe("a host service wrapper as the transport", () => {
  it("can sign each request and retry on the provider's say-so, without a hook of its own", async () => {
    const { http: host, calls } = fakeHost([
      { status: 401, headers: { "dpop-nonce": "n1" } },
      { body: '{"detail":{"name":"n"}}' },
    ]);
    const signing: HttpHostServices = {
      request: async (req) => {
        let answer = await host.request({ ...req, headers: { ...req.headers, DPoP: "none" } });
        const nonce = answer.headers["dpop-nonce"];
        if (answer.status === 401 && nonce) {
          answer = await host.request({ ...req, headers: { ...req.headers, DPoP: nonce } });
        }
        return answer;
      },
    };
    const api = createApiClient<paths>({ vendor: "E", baseUrl: BASE, headers: {}, http: signing });
    expect(await api.get("/single")).toEqual({ detail: { name: "n" } });
    expect(calls.map((c) => c.headers["DPoP"])).toEqual(["none", "n1"]);
  });
});

describe("withCursorPagination, from what the whole page says", () => {
  const counted = (headerName = "x-next-page") =>
    withCursorPagination(client(), {
      cursorParam: "page",
      firstCursor: 1,
      sizeParam: "per_page",
      pageSize: 2,
      maxPages: 5,
      continueOnEmptyPage: true,
      next: ({ headers }) => headers[headerName],
    });

  it("sends firstCursor on the first request, after the size", async () => {
    fetchMock.mockResolvedValueOnce(paged({ items: [{ id: 1 }] }));
    await counted().getAll("/items", "items");
    expect(lastUrl()).toBe(`${BASE}/items?per_page=2&page=1`);
  });

  it("follows a page number in a header, past an empty page, until it is blank", async () => {
    fetchMock
      .mockResolvedValueOnce(paged({ items: [{ id: 1 }] }, { "X-Next-Page": "4" }))
      .mockResolvedValueOnce(paged({ items: [] }, { "X-Next-Page": "5" }))
      .mockResolvedValueOnce(paged({ items: [{ id: 2 }] }, { "X-Next-Page": "" }));
    const items = await counted().getAll("/items", "items");
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/items?per_page=2&page=1`,
      `${BASE}/items?per_page=2&page=4`,
      `${BASE}/items?per_page=2&page=5`,
    ]);
  });

  it("tells the function everything about the page", async () => {
    const seen: PageAnswer[] = [];
    fetchMock.mockResolvedValueOnce(paged({ items: [{ id: 1 }] }, { "X-A": "b" }));
    const api = withCursorPagination(client(), {
      cursorParam: "page",
      firstCursor: 3,
      sizeParam: "per_page",
      pageSize: 7,
      maxPages: 5,
      next: (page) => {
        seen.push(page);
        return null;
      },
    });
    await api.getAll("/items", "items");
    expect(seen[0]).toMatchObject({
      headers: { "x-a": "b" },
      body: { items: [{ id: 1 }] },
      items: [{ id: 1 }],
      cursor: "3",
      pageSize: 7,
    });
  });

  it("stops after the page stopWhen says is enough, having kept that page", async () => {
    fetchMock.mockResolvedValue(paged({ items: [{ id: 1, name: "old" }] }, { "X-Next-Page": "2" }));
    fetchMock.mockImplementation(async () =>
      paged({ items: [{ id: 1, name: "old" }] }, { "X-Next-Page": "2" }),
    );
    const items = await counted().getAll("/items", "items", {
      stopWhen: (batch) => batch.some((item) => item.name === "old"),
    });
    expect(items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("walks an offset, which is a cursor worked out from the page", async () => {
    fetchMock
      .mockResolvedValueOnce(paged({ rows: [{ id: 1 }, { id: 2 }] }))
      .mockResolvedValueOnce(paged({ rows: [{ id: 3 }] }))
      .mockResolvedValueOnce(paged({ rows: [] }));
    const api = withCursorPagination(client(), {
      cursorParam: "offset",
      firstCursor: 0,
      sizeParam: "limit",
      pageSize: 2,
      maxPages: 5,
      next: ({ cursor, items }) => Number(cursor) + items.length,
    });
    expect(await api.getAll("/offset", "rows")).toHaveLength(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/offset?limit=2&offset=0`,
      `${BASE}/offset?limit=2&offset=2`,
      `${BASE}/offset?limit=2&offset=3`,
    ]);
  });

  it("walks page numbers that count from zero", async () => {
    fetchMock
      .mockResolvedValueOnce(paged({ items: [{ id: 1 }] }))
      .mockResolvedValueOnce(paged({ items: [] }));
    const api = withCursorPagination(client(), {
      cursorParam: "page",
      firstCursor: 0,
      maxPages: 5,
      next: ({ cursor }) => Number(cursor) + 1,
    });
    expect(await api.getAll("/items", "items")).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/items?page=0`,
      `${BASE}/items?page=1`,
    ]);
  });

  it("lets onTruncated throw, so a reader can refuse a partial list", async () => {
    fetchMock.mockImplementation(async () => paged({ items: [{ id: 1 }] }, { "X-Next-Page": "2" }));
    const api = withCursorPagination(client(), {
      cursorParam: "page",
      maxPages: 2,
      next: ({ headers }) => headers["x-next-page"],
      onTruncated: ({ path, maxPages }) => {
        throw new Error(`${path} has more than ${maxPages} pages`);
      },
    });
    await expect(api.getAll("/items", "items")).rejects.toThrow("/items has more than 2 pages");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads a cursor out of a Link header, to send back as a parameter", async () => {
    fetchMock
      .mockResolvedValueOnce(
        paged({ items: [{ id: 1 }] }, { Link: '<https://x.test/items?page=9>; rel="next"' }),
      )
      .mockResolvedValueOnce(paged({ items: [{ id: 2 }] }));
    const api = withCursorPagination(client(), {
      cursorParam: "page",
      maxPages: 5,
      next: nextLinkHeader(),
      readCursor: (link) => new URL(link).searchParams.get("page"),
    });
    await api.getAll("/items", "items");
    expect(lastUrl()).toBe(`${BASE}/items?page=9`);
  });
});

describe("withLinkPagination", () => {
  const scoped = () =>
    createApiClient<paths>({
      vendor: "Example",
      baseUrl: BASE,
      headers: { Authorization: "Bearer t" },
      scopeQuery: { team: "t1" },
    });
  const link = (url: string, rest = 'rel="next"') => ({ Link: `<${url}>; ${rest}` });

  const headerWalk = (extra: { maxPages?: number } = {}) =>
    withLinkPagination(client(), {
      next: nextLinkHeader(),
      sizeParam: "limit",
      pageSize: 2,
      maxPages: extra.maxPages ?? 5,
      foreignLinks: "follow",
    });

  describe("following", () => {
    it("asks for the path once, then each link exactly as written", async () => {
      const odd = `${BASE}/apps?after=a%20b&x=[1]&limit=2`;
      fetchMock
        .mockResolvedValueOnce(paged([{ id: 1 }], link(odd)))
        .mockResolvedValueOnce(paged([{ id: 2 }]));
      const items = await headerWalk().getAll("/apps", null, { query: { q: "x y" } });
      expect(items).toEqual([{ id: 1 }, { id: 2 }]);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        `${BASE}/apps?q=x+y&limit=2`,
        odd,
      ]);
    });

    it("sends the client's headers with a link, and does not add scopeQuery to it", async () => {
      fetchMock
        .mockResolvedValueOnce(paged([{ id: 1 }], link(`${BASE}/apps?after=1`)))
        .mockResolvedValueOnce(paged([{ id: 2 }]));
      const api = withLinkPagination(scoped(), {
        next: nextLinkHeader(),
        maxPages: 5,
        foreignLinks: "follow",
      });
      await api.getAll("/apps", null);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/apps?team=t1`);
      expect(lastUrl()).toBe(`${BASE}/apps?after=1`);
      expect(lastInit()?.headers).toMatchObject({ Authorization: "Bearer t" });
    });

    it("works through the host's http service, whose headers come in any case", async () => {
      const { http, calls } = fakeHost([
        { headers: { LINK: `<${BASE}/apps?after=1>; rel="next"` }, body: '[{"id":1}]' },
        { body: '[{"id":2}]' },
      ]);
      const api = withLinkPagination(
        createApiClient<paths>({ vendor: "E", baseUrl: BASE, headers: {}, http, caCert: "PEM" }),
        { next: nextLinkHeader(), maxPages: 5, foreignLinks: "follow" },
      );
      expect(await api.getAll("/apps", null)).toEqual([{ id: 1 }, { id: 2 }]);
      expect(calls.map((c) => [c.url, c.caCert])).toEqual([
        [`${BASE}/apps`, "PEM"],
        [`${BASE}/apps?after=1`, "PEM"],
      ]);
    });

    it("resolves a relative link against the page it came from", async () => {
      fetchMock
        .mockResolvedValueOnce(paged([{ id: 1 }], link("/v2/other?a=1")))
        .mockResolvedValueOnce(paged([{ id: 2 }], link("?a=2")))
        .mockResolvedValueOnce(paged([{ id: 3 }], link("next-one")))
        .mockResolvedValueOnce(paged([]));
      await headerWalk().getAll("/apps", null);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        `${BASE}/apps?limit=2`,
        "https://api.example.test/v2/other?a=1",
        "https://api.example.test/v2/other?a=2",
        "https://api.example.test/v2/next-one",
      ]);
    });

    it("reads a link from a body field, and collects from a key", async () => {
      fetchMock
        .mockResolvedValueOnce(
          paged({ calls: [{ id: 1 }], next_page_uri: "/2010/Calls?Page=1&PageToken=x" }),
        )
        .mockResolvedValueOnce(paged({ calls: [{ id: 2 }], next_page_uri: null }));
      const api = withLinkPagination(client(), {
        next: "next_page_uri",
        sizeParam: "PageSize",
        pageSize: 1000,
        maxPages: 5,
        foreignLinks: "follow",
      });
      expect(await api.getAll("/twilio", "calls")).toEqual([{ id: 1 }, { id: 2 }]);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        `${BASE}/twilio?PageSize=1000`,
        "https://api.example.test/2010/Calls?Page=1&PageToken=x",
      ]);
    });

    it("reads a link from a nested body field", async () => {
      fetchMock
        .mockResolvedValueOnce(
          paged({ rows: [{ id: 1 }], meta: { next_page_url: "https://x.test/more" } }),
        )
        .mockResolvedValueOnce(paged({ rows: [{ id: 2 }], meta: { next_page_url: null } }));
      const api = withLinkPagination(client(), {
        next: "meta.next_page_url",
        maxPages: 5,
        foreignLinks: "follow",
      });
      await api.getAll("/meta-link", "rows");
      expect(lastUrl()).toBe("https://x.test/more");
    });
  });

  describe("resolveLink", () => {
    const concatenating = (extra: { foreignLinks?: "follow" | "refuse" } = {}) =>
      withLinkPagination(client(), {
        next: "next_page_uri",
        sizeParam: "PageSize",
        pageSize: 1000,
        pagingFirst: true,
        maxPages: 5,
        foreignLinks: extra.foreignLinks ?? "follow",
        continueOnEmptyPage: true,
        resolveLink: (link) => (link.startsWith("http") ? link : `https://host.test${link}`),
      });
    const pages = (...links: unknown[]) => {
      for (const next_page_uri of links) {
        fetchMock.mockResolvedValueOnce(paged({ calls: [{ id: 1 }], next_page_uri }));
      }
    };

    it("sends what it answers as it stands, spaces and all, without resolving", async () => {
      pages("//evil.test/x y", "no-slash?a=b c", null);
      await concatenating().getAll("/twilio", "calls");
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        `${BASE}/twilio?PageSize=1000`,
        "https://host.test//evil.test/x y",
        "https://host.testno-slash?a=b c",
      ]);
    });

    it("sees the link even if it is not a string, and an empty answer ends the list", async () => {
      const seen: unknown[] = [];
      pages(5);
      const api = withLinkPagination(client(), {
        next: "next_page_uri",
        maxPages: 5,
        foreignLinks: "follow",
        resolveLink: (link) => {
          seen.push(link);
          return null;
        },
      });
      await expect(api.getAll("/twilio", "calls")).resolves.toHaveLength(1);
      expect(seen).toEqual([5]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("is what `refuse` looks at", async () => {
      pages("https://evil.test/x");
      await expect(
        concatenating({ foreignLinks: "refuse" }).getAll("/twilio", "calls"),
      ).rejects.toThrow("from https://api.example.test to https://evil.test");
    });

    it("can answer something that is not a URL, which fails where the transport says so", async () => {
      const { http, calls } = fakeHost([
        { body: '{"calls":[{"id":1}],"next_page_uri":"httpfoo"}' },
        { status: 500, body: "boom" },
      ]);
      const failures: ApiFailure[] = [];
      const api = withLinkPagination(
        createApiClient<paths>({
          vendor: "E",
          baseUrl: BASE,
          headers: {},
          http,
          httpError: (failure) => {
            failures.push(failure);
            return new Error("failed");
          },
        }),
        {
          next: "next_page_uri",
          maxPages: 5,
          foreignLinks: "follow",
          resolveLink: (link) => link,
        },
      );
      await expect(api.getAll("/twilio", "calls")).rejects.toThrow("failed");
      expect(calls[1]?.url).toBe("httpfoo");
      expect(failures[0]).toMatchObject({
        path: "httpfoo",
        target: "httpfoo",
        url: "httpfoo",
        link: "httpfoo",
      });
    });

    it("tells httpError the link as written, and the first page has none", async () => {
      const failures: ApiFailure[] = [];
      const api = withLinkPagination(
        createApiClient<paths>({
          vendor: "E",
          baseUrl: BASE,
          headers: {},
          httpError: (failure) => {
            failures.push(failure);
            return new Error("failed");
          },
        }),
        { next: "next_page_uri", maxPages: 5, foreignLinks: "follow" },
      );
      fetchMock.mockResolvedValueOnce(paged("boom", {}, 500));
      await expect(api.getAll("/twilio", "calls")).rejects.toThrow("failed");
      expect(failures[0]).not.toHaveProperty("link");
      fetchMock
        .mockResolvedValueOnce(paged({ calls: [{ id: 1 }], next_page_uri: "/rel?a=1" }))
        .mockResolvedValueOnce(paged("boom", {}, 500));
      await expect(api.getAll("/twilio", "calls")).rejects.toThrow("failed");
      expect(failures[1]).toMatchObject({
        link: "/rel?a=1",
        path: "/rel",
        url: "https://api.example.test/rel?a=1",
      });
    });
  });

  it("sends the size first when told to, and only on the first request", async () => {
    fetchMock
      .mockResolvedValueOnce(paged({ rows: [{ id: 1 }], next_page_uri: "/more" }))
      .mockResolvedValueOnce(paged({ rows: [], next_page_uri: null }));
    const api = withLinkPagination(client(), {
      next: "next_page_uri",
      sizeParam: "PageSize",
      pageSize: 9,
      pagingFirst: true,
      maxPages: 5,
      foreignLinks: "follow",
    });
    await api.getAll("/required-filter", "rows", { query: { project: "p" } });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${BASE}/required-filter?PageSize=9&project=p`,
      "https://api.example.test/more",
    ]);
  });

  describe("a link to another host", () => {
    const foreign = "https://evil.test/apps?after=1";

    it("is followed, credentials and all, when the plugin says so", async () => {
      fetchMock
        .mockResolvedValueOnce(paged([{ id: 1 }], link(foreign)))
        .mockResolvedValueOnce(paged([{ id: 2 }]));
      expect(await headerWalk().getAll("/apps", null)).toHaveLength(2);
      expect(lastUrl()).toBe(foreign);
      expect(lastInit()?.headers).toMatchObject({ Authorization: "Bearer t" });
    });

    it("throws without asking when it says not to", async () => {
      fetchMock.mockResolvedValueOnce(paged([{ id: 1 }], link(foreign)));
      const api = withLinkPagination(client(), {
        next: nextLinkHeader(),
        maxPages: 5,
        foreignLinks: "refuse",
      });
      await expect(api.getAll("/apps", null)).rejects.toThrow(
        "from https://api.example.test to https://evil.test",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("lets a link on the same origin through either way", async () => {
      fetchMock
        .mockResolvedValueOnce(paged([{ id: 1 }], link(`${BASE}/apps?after=1`)))
        .mockResolvedValueOnce(paged([{ id: 2 }]));
      const api = withLinkPagination(client(), {
        next: nextLinkHeader(),
        maxPages: 5,
        foreignLinks: "refuse",
      });
      expect(await api.getAll("/apps", null)).toHaveLength(2);
    });

    it("compares origins, so another port or scheme is another host", async () => {
      for (const other of ["https://api.example.test:8443/x", "http://api.example.test/x"]) {
        fetchMock.mockResolvedValueOnce(paged([{ id: 1 }], link(other)));
        const api = withLinkPagination(client(), {
          next: nextLinkHeader(),
          maxPages: 5,
          foreignLinks: "refuse",
        });
        await expect(api.getAll("/apps", null)).rejects.toThrow(/Refusing/);
      }
    });
  });

  describe("termination", () => {
    it("ends when a page has no Link header, or none for rel=next", async () => {
      fetchMock.mockResolvedValueOnce(paged([{ id: 1 }]));
      expect(await headerWalk().getAll("/apps", null)).toHaveLength(1);
      fetchMock.mockResolvedValueOnce(paged([{ id: 1 }], link(`${BASE}/first`, 'rel="prev"')));
      expect(await headerWalk().getAll("/apps", null)).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("ends on an empty page by default, and goes on past one when told", async () => {
      fetchMock.mockResolvedValueOnce(paged([], link(`${BASE}/apps?a=1`)));
      expect(await headerWalk().getAll("/apps", null)).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock
        .mockResolvedValueOnce(paged([], link(`${BASE}/apps?a=1`)))
        .mockResolvedValueOnce(paged([{ id: 2 }]));
      const api = withLinkPagination(client(), {
        next: nextLinkHeader(),
        maxPages: 5,
        foreignLinks: "follow",
        continueOnEmptyPage: true,
      });
      expect(await api.getAll("/apps", null)).toEqual([{ id: 2 }]);
    });

    it("throws at maxPages on a link that repeats", async () => {
      fetchMock.mockImplementation(async () => paged([{ id: 1 }], link(`${BASE}/apps?same=1`)));
      const onTruncated = vi.fn();
      const api = withLinkPagination(client(), {
        next: nextLinkHeader(),
        maxPages: 3,
        foreignLinks: "follow",
        onTruncated,
      });
      await expect(api.getAll("/apps", null)).rejects.toThrow(ListTruncatedError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(onTruncated).toHaveBeenCalledWith({ path: "/apps", items: 3, maxPages: 3 });
    });

    it("stops on a repeating link when told to, without calling it truncated", async () => {
      fetchMock.mockImplementation(async () => paged([{ id: 1 }], link(`${BASE}/apps?same=1`)));
      const onTruncated = vi.fn();
      const api = withLinkPagination(client(), {
        next: nextLinkHeader(),
        maxPages: 9,
        foreignLinks: "follow",
        stopOnRepeatedCursor: true,
        onTruncated,
      });
      await api.getAll("/apps", null);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onTruncated).not.toHaveBeenCalled();
    });

    it("takes pageSize, maxPages and stopWhen per call", async () => {
      fetchMock.mockImplementation(async () => paged([{ id: 1 }], link(`${BASE}/apps?n=1`)));
      await headerWalk().getAll("/apps", null, { pageSize: 9, maxPages: 2, partial: true });
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/apps?limit=9`);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockClear();
      await headerWalk().getAll("/apps", null, { stopWhen: () => true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("propagates a failed page, and keeps the client's other verbs", async () => {
      fetchMock
        .mockResolvedValueOnce(paged([{ id: 1 }], link(`${BASE}/apps?n=1`)))
        .mockResolvedValueOnce(paged("boom", {}, 500));
      await expect(headerWalk().getAll("/apps", null)).rejects.toThrow("/apps?n=1: boom");

      fetchMock.mockResolvedValueOnce(paged({ detail: { name: "n" } }));
      expect(await headerWalk().get("/single")).toEqual({ detail: { name: "n" } });
    });

    it("forwards an abort signal to every page", async () => {
      const { signal } = new AbortController();
      fetchMock
        .mockResolvedValueOnce(paged([{ id: 1 }], link(`${BASE}/apps?n=1`)))
        .mockResolvedValueOnce(paged([]));
      await headerWalk().getAll("/apps", null, { signal });
      expect(fetchMock.mock.calls.map(([, init]) => init?.signal)).toEqual([signal, signal]);
    });
  });
});

describe("nextLinkHeader", () => {
  const read = (link: string | undefined, options?: Parameters<typeof nextLinkHeader>[0]) =>
    nextLinkHeader(options)({
      headers: link === undefined ? {} : { link },
      body: undefined,
      items: [],
      cursor: undefined,
      pageSize: undefined,
    });

  it("picks rel=next among several links", () => {
    expect(
      read('<https://a/1>; rel="prev", <https://a/2>; rel="next", <https://a/3>; rel="last"'),
    ).toBe("https://a/2");
  });

  it("reads rel unquoted, in any case, and among several values", () => {
    expect(read("<https://a/2>; rel=next")).toBe("https://a/2");
    expect(read('<https://a/2>; REL="NEXT"')).toBe("https://a/2");
    expect(read('<https://a/2>; rel="last next"')).toBe("https://a/2");
  });

  it("does not take a rel that merely contains the word", () => {
    expect(read('<https://a/2>; rel="nextish"')).toBeUndefined();
    expect(read("<https://a/2>; title=next")).toBeUndefined();
  });

  it("is undefined with no header, a blank one, or none that parses", () => {
    expect(read(undefined)).toBeUndefined();
    expect(read("")).toBeUndefined();
    expect(read('https://a/2; rel="next"')).toBeUndefined();
  });

  it("asks `when` about the parameters, for a link that is always sent", () => {
    const hasResults = {
      when: (params: Record<string, string>) => params["results"] === "true",
    };
    const sentry = (results: string) =>
      `<https://s/a?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://s/a?&cursor=0:100:0>; rel="next"; results="${results}"; cursor="0:100:0"`;
    expect(read(sentry("true"), hasResults)).toBe("https://s/a?&cursor=0:100:0");
    expect(read(sentry("false"), hasResults)).toBeUndefined();
  });

  it("takes another rel", () => {
    expect(read('<https://a/1>; rel="prev"', { rel: "PREV" })).toBe("https://a/1");
  });
});

describe("parseLinkHeader", () => {
  it("keeps a comma or semicolon inside a URL or a quoted parameter", () => {
    expect(
      parseLinkHeader(
        '<https://a/x?ids=1,2;3>; rel="next"; title="a, b; c", <https://a/y>; rel=last',
      ),
    ).toEqual([
      { url: "https://a/x?ids=1,2;3", params: { rel: "next", title: "a, b; c" } },
      { url: "https://a/y", params: { rel: "last" } },
    ]);
  });

  it("lower-cases parameter names, keeps the first of a repeat, and takes one with no value", () => {
    expect(parseLinkHeader('<u>; REL=next; rel=last; Flag; x = "y"')).toEqual([
      { url: "u", params: { rel: "next", flag: "", x: "y" } },
    ]);
  });

  it("is empty for nothing", () => {
    expect(parseLinkHeader(undefined)).toEqual([]);
    expect(parseLinkHeader("")).toEqual([]);
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

  // A next link's field is checked against the document, and a typo fails at the config.
  const links = withLinkPagination(api, {
    next: "next_page_uri",
    sizeParam: "PageSize",
    maxPages: 2,
    foreignLinks: "follow",
  });
  void links.getAll("/twilio", "calls");
  // @ts-expect-error
  void links.getAll("/meta-link", "rows");
  // @ts-expect-error
  void links.getAll("/twilio", "nope");
  // @ts-expect-error a field no operation has
  withLinkPagination(api, { next: "next_page_ur", maxPages: 2, foreignLinks: "follow" });
  withLinkPagination(api, {
    // @ts-expect-error a size parameter no operation has fails on what it asks of `next`
    next: "next_page_uri",
    sizeParam: "size",
    maxPages: 2,
    foreignLinks: "follow",
  });

  // Which way a foreign link goes is not optional, and is one of the two.
  // @ts-expect-error
  withLinkPagination(api, { next: nextLinkHeader(), maxPages: 2 });
  // @ts-expect-error
  withLinkPagination(api, { next: nextLinkHeader(), maxPages: 2, foreignLinks: "maybe" });
  // @ts-expect-error
  withLinkPagination(api, { next: nextLinkHeader(), foreignLinks: "follow" });

  // A link walk has no cursor to configure.
  withLinkPagination(api, {
    next: nextLinkHeader(),
    maxPages: 2,
    foreignLinks: "follow",
    // @ts-expect-error
    cursorParam: "after",
  });

  // A link in a header fits any list, even one with no query, since nothing is read
  // from the body; the size parameter, where there is one, still has to exist.
  const headerLinks = withLinkPagination(api, {
    next: nextLinkHeader(),
    maxPages: 2,
    foreignLinks: "follow",
  });
  void headerLinks.getAll("/no-query", null);
  void headerLinks.getAll("/apps", null);
  // @ts-expect-error not a list
  void headerLinks.getAll("/single", null);
  const sized = withLinkPagination(api, {
    next: nextLinkHeader(),
    sizeParam: "limit",
    maxPages: 2,
    foreignLinks: "follow",
  });
  void sized.getAll("/apps", null);
  // @ts-expect-error the size belongs to the helper
  void sized.getAll("/apps", null, { query: { limit: 1 } });
  void sized.getAll("/apps", null, { query: { q: "x" } });
  // @ts-expect-error `limit` is not a parameter of this one
  void sized.getAll("/no-query", null);

  // A function reading the page stands in for a field, and the rest stays checked.
  const counted = withCursorPagination(api, {
    cursorParam: "page",
    firstCursor: 1,
    sizeParam: "per_page",
    maxPages: 2,
    next: ({ headers, items, cursor }) => (items.length > 0 ? headers["x-next-page"] : cursor),
  });
  void counted.getAll("/items", "items");
  // @ts-expect-error the cursor parameter is not on this operation
  void counted.getAll("/nested", "things");
  // @ts-expect-error
  void counted.getAll("/items", "items", { query: { page: 1 } });
  // @ts-expect-error a stop condition sees the list's own items
  void counted.getAll("/items", "items", { stopWhen: (batch) => batch[0]?.nope === 1 });
  void counted.getAll("/items", "items", { stopWhen: (batch) => batch[0]?.name === "x" });

  // Headers and text come back typed, and are only for what the document lists.
  void (async () => {
    const { headers, body, status, url } = await api.getResponse("/single");
    const total: string | undefined = headers["x-total"];
    const name: string = body.detail.name;
    const text: string = (await api.getText("/single")).body;
    // @ts-expect-error
    const missing = body.nope;
    return { total, name, text, status, url, missing };
  });
  // @ts-expect-error
  void api.getResponse("/not-listed");
  // @ts-expect-error
  void api.getText("/not-listed");
  // @ts-expect-error a parameter that did not go through pathEncode
  void api.getText(`/items/${raw}`);
  // @ts-expect-error
  void api.getText("/items", { query: { pagee: 1 } });

  // A list whose only parameter is the size has nothing left for a caller to send.
  const sizeOnly = withLinkPagination(api, {
    next: "next_page_uri",
    sizeParam: "PageSize",
    maxPages: 2,
    foreignLinks: "follow",
  });
  void sizeOnly.getAll("/size-only", "rows");
  void sizeOnly.getAll("/size-only", "rows", { signal: new AbortController().signal });
  // @ts-expect-error
  void sizeOnly.getAll("/size-only", "rows", { query: { anything: 1 } });
  // @ts-expect-error the size belongs to the helper
  void sizeOnly.getAll("/size-only", "rows", { query: { PageSize: 1 } });

  // A parameter the document requires stays compulsory on a list.
  // @ts-expect-error
  void sizeOnly.getAll("/required-filter", "rows");
  // @ts-expect-error
  void sizeOnly.getAll("/required-filter", "rows", {});
  // @ts-expect-error
  void sizeOnly.getAll("/required-filter", "rows", { query: { project: 1 } });
  void sizeOnly.getAll("/required-filter", "rows", { query: { project: "p" } });

  // A form operation takes `form` and only `form`, typed from what the document says.
  void api.post("/form", { form: { Name: "n", Sticky: true, Size: 1, Tag: ["t"] } });
  void api.post("/form");
  // @ts-expect-error a JSON body on a form operation
  void api.post("/form", { body: { Name: "n" } });
  // @ts-expect-error an unknown field
  void api.post("/form", { form: { Name: "n", Nope: 1 } });
  // @ts-expect-error a wrong type: a boolean field is not text
  void api.post("/form", { form: { Name: "n", Sticky: "true" } });
  // @ts-expect-error a required field left out
  void api.post("/form", { form: { Size: 1 } });
  // `undefined` for a required key means "let the provider say so", as in a JSON body.
  const formName: string | undefined = raw;
  void api.post("/form", { form: { Name: formName } });
  // @ts-expect-error a form the document requires
  void api.post("/form-required");
  // @ts-expect-error a form on a JSON operation
  void api.post("/items", { form: { name: "n" } });
  const named: ApiForm<paths["/form"]["post"]> = { Name: "n" };
  void api.post("/form", { form: named });

  // Where the document has both, the key decides which schema applies, and not both.
  void api.post("/either", { body: { asJson: "x" } });
  void api.post("/either", { form: { asForm: "x" } });
  // @ts-expect-error
  void api.post("/either", { body: { asForm: "x" } });
  // @ts-expect-error
  void api.post("/either", { form: { asJson: "x" } });
  // @ts-expect-error
  void api.post("/either", { body: { asJson: "x" }, form: { asForm: "x" } });
  // @ts-expect-error
  void api.post("/either");

  // A required body the client cannot encode does not compile, rather than send nothing.
  // @ts-expect-error
  void api.post("/upload");
  // @ts-expect-error
  void api.post("/upload", {});
  // @ts-expect-error
  void api.post("/upload", { body: { file: "x" } });
  // @ts-expect-error
  void api.post("/upload", { form: { file: "x" } });
  // An optional one can be left out, and still cannot be written.
  void api.patch("/upload");
  // @ts-expect-error
  void api.patch("/upload", { body: "bytes" });

  // JSON under another name is still JSON, and `application/json` wins where both exist.
  void (async () => {
    const vendor: string = (await api.get("/vendor-json")).acme;
    const charset: string = (await api.put("/vendor-json", { body: { acme: "a" } })).charset;
    const plain: string = (await api.post("/vendor-json")).plain;
    // @ts-expect-error only application/json is read when there is one
    const other = (await api.post("/vendor-json")).acme;
    // @ts-expect-error
    void api.put("/vendor-json", { body: { nope: "a" } });
    const csv: never = await api.get("/not-json");
    return { vendor, charset, plain, other, csv };
  });

  // Every 2xx answers, and nothing else does.
  void (async () => {
    const odd = await api.get("/odd-codes");
    const partial = "partial" in odd ? odd.partial : undefined;
    const multi = "multi" in odd ? odd.multi : undefined;
    const wild = "wild" in odd ? odd.wild : undefined;
    // A 301 is not an answer, so this union has no room for one.
    const only: { partial: true } | { multi: true } | { wild: true } = odd;
    return { partial, multi, wild, only };
  });

  // A plugin's own encoder fits as it is, recursive type and all.
  type OwnFormValue =
    string | number | boolean | null | undefined | OwnFormValue[] | { [key: string]: OwnFormValue };
  const ownEncoder = (form: Record<string, OwnFormValue>) => JSON.stringify(form);
  void createApiClient<paths>({
    vendor: "E",
    baseUrl: BASE,
    headers: {},
    serializeForm: ownEncoder,
  });

  // Headers go on any call and any walk, and are only ever strings.
  void api.get("/items", { headers: { "If-Match": "e" } });
  void sizeOnly.getAll("/size-only", "rows", { headers: { Accept: "x" } });
  // @ts-expect-error
  void api.get("/items", { headers: { "If-Match": 1 } });

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

describe("requireListPage", () => {
  const where = { vendor: "Test", path: "/x", key: "items" };

  it("hands back an array, empty or not", () => {
    expect(requireListPage([1, 2], where)).toEqual([1, 2]);
    expect(requireListPage([], where)).toEqual([]);
  });

  it.each([[undefined], [null]])("refuses %s", (value) => {
    expect(() => requireListPage<number>(value, where)).toThrow(ListPageError);
  });
});

describe("an incomplete list inside a catch", () => {
  const failure = new ListPageError({ vendor: "Test", path: "/x", key: "items", found: null });

  it("is recognised by its marker, directly or as a cause, across bundled copies", () => {
    expect(isIncompleteListError(failure)).toBe(true);
    expect(isIncompleteListError(new Error("wrapped", { cause: failure }))).toBe(true);
    // What another bundled copy of this class looks like from here.
    expect(isIncompleteListError(Object.assign(new Error("x"), { incompleteList: true }))).toBe(
      true,
    );
    expect(isIncompleteListError(new Error("x"))).toBe(false);
    expect(isIncompleteListError("x")).toBe(false);
    expect(isIncompleteListError(null)).toBe(false);
  });

  it("is rethrown, and anything else left to the catch", () => {
    expect(() => rethrowIncompleteList(failure)).toThrow(failure);
    expect(() => rethrowIncompleteList(new Error("404"))).not.toThrow();
  });
});

describe("withinListCap", () => {
  const place = { vendor: "Test", path: "/subaccounts" };

  it("hands back a list that fits", () => {
    expect(withinListCap([1, 2], 2, place)).toEqual([1, 2]);
  });

  it("refuses one that does not, saying how many there were and the cap", () => {
    expect(() => withinListCap([1, 2, 3], 2, place)).toThrow(ListTruncatedError);
    expect(() => withinListCap([1, 2, 3], 2, place)).toThrow(
      "Test: /subaccounts has more than Infrawrench reads. It stopped at 2 items",
    );
  });
});

describe("a host watching for a swallowed list error", () => {
  const hook = Symbol.for("infrawrench.incompleteList");
  afterEach(() => Reflect.deleteProperty(globalThis, hook));

  it("is told when one is made, whatever happens to it next", () => {
    const seen = vi.fn();
    Reflect.set(globalThis, hook, seen);
    const made = new ListTruncatedError({ vendor: "Test", path: "/x", items: 1, maxPages: 1 });
    expect(seen).toHaveBeenCalledExactlyOnceWith(made);
  });
});
