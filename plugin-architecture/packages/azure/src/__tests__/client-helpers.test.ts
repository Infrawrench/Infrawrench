import { describe, it, expect, vi, afterEach } from "vitest";
import { listAcrArtifacts } from "../container-registry-client.js";
import { listAppRegistrations } from "../app-registration.js";
import { makeGraphClient } from "../graph-client.js";
import * as auth from "../auth.js";
import type { AzureHttpContext } from "../shared.js";

// The real Graph SDK rewrites the supplied authProvider into its internal
// authentication-provider contract, so it isn't reachable as `config.authProvider`.
// Mock Client.init to echo back the config so makeGraphClient's wiring is testable.
vi.mock("@microsoft/microsoft-graph-client", () => ({
  Client: { init: (config: unknown) => ({ config }) },
}));

const creds = { tenantId: "t1", clientId: "c1", clientSecret: "s1", subscriptionId: "sub1" };

function httpCtx(get: (url: string) => unknown): AzureHttpContext {
  return {
    get: vi.fn(async (url: string) => get(url)),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => undefined),
    subscriptionId: "sub1",
    tenantId: "t1",
  } as unknown as AzureHttpContext;
}

afterEach(() => vi.restoreAllMocks());

describe("listAcrArtifacts", () => {
  function mockAcrFetch(handlers: Record<string, () => Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      for (const [key, fn] of Object.entries(handlers)) {
        if (url.includes(key)) return fn();
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }
  const ok = (body: unknown): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => "",
    }) as unknown as Response;

  it("rejects unsupported types", async () => {
    await expect(
      listAcrArtifacts(
        httpCtx(() => ({})),
        creds,
        "azure-vm",
        "id",
        "acct",
      ),
    ).rejects.toThrow(/not supported/);
  });

  it("rejects an invalid registry resource id", async () => {
    await expect(
      listAcrArtifacts(
        httpCtx(() => ({})),
        creds,
        "azure-container-registry",
        "badid",
        "acct",
      ),
    ).rejects.toThrow(/Invalid azure-container-registry/);
  });

  it("walks the AAD→refresh→access token dance and groups tags by digest", async () => {
    vi.spyOn(auth, "fetchAcrAccessToken").mockResolvedValue("aad-tok");
    const ctx = httpCtx(() => ({ properties: { loginServer: "acr1.azurecr.io" } }));
    mockAcrFetch({
      "/oauth2/exchange": () => ok({ refresh_token: "refresh-1" }),
      "/oauth2/token": () => ok({ access_token: "acr-access" }),
      _catalog: () => ok({ repositories: ["app", "lib"] }),
      "/app/_tags": () =>
        ok({
          tags: [
            { name: "v1", digest: "sha:1", lastUpdateTime: "2024" },
            { name: "latest", digest: "sha:1" },
          ],
        }),
      "/lib/_tags": () => ok({ tags: [] }),
    });
    const result = await listAcrArtifacts(
      ctx,
      creds,
      "azure-container-registry",
      "acct:azure-container-registry:rg1/acr1",
      "acct",
    );
    const app = result.items.find((i) => i.name === "app");
    expect(app!.tags).toEqual(["v1", "latest"]);
    expect(app!.digest).toBe("sha:1");
    // lib has no tags → bare entry
    expect(result.items.find((i) => i.name === "lib")).toMatchObject({ name: "lib" });
  });

  it("throws when the ACR token exchange fails", async () => {
    vi.spyOn(auth, "fetchAcrAccessToken").mockResolvedValue("aad-tok");
    const ctx = httpCtx(() => ({ properties: { loginServer: "acr1.azurecr.io" } }));
    mockAcrFetch({
      "/oauth2/exchange": () =>
        ({ ok: false, status: 401, text: async () => "denied" }) as unknown as Response,
    });
    await expect(
      listAcrArtifacts(
        ctx,
        creds,
        "azure-container-registry",
        "acct:azure-container-registry:rg1/acr1",
        "acct",
      ),
    ).rejects.toThrow(/ACR token exchange failed: 401/);
  });

  it("falls back to a bare entry when a repo's tags request fails", async () => {
    vi.spyOn(auth, "fetchAcrAccessToken").mockResolvedValue("aad-tok");
    const ctx = httpCtx(() => ({ properties: {} }));
    mockAcrFetch({
      "/oauth2/exchange": () => ok({ refresh_token: "r" }),
      "/oauth2/token": () => ok({ access_token: "a" }),
      _catalog: () => ok({ repositories: ["solo"] }),
      "/solo/_tags": () =>
        ({ ok: false, status: 404, text: async () => "nf" }) as unknown as Response,
    });
    const result = await listAcrArtifacts(
      ctx,
      creds,
      "azure-container-registry",
      "rg1/acr1",
      "acct",
    );
    expect(result.items).toEqual([{ name: "solo" }]);
  });
});

describe("listAppRegistrations", () => {
  function graphMock(pages: {
    apps: unknown[];
    nextLink?: string;
    secondPage?: unknown[];
    spByAppId?: Record<string, string>;
  }) {
    let appCall = 0;
    const api = vi.fn((path: string) => {
      if (path === "/applications") {
        return {
          top: () => ({
            select: () => ({
              get: async () => ({ value: pages.apps, "@odata.nextLink": pages.nextLink }),
            }),
          }),
        };
      }
      if (path === pages.nextLink) {
        return {
          get: async () => {
            appCall++;
            return { value: pages.secondPage ?? [] };
          },
        };
      }
      if (path === "/servicePrincipals") {
        return {
          filter: (f: string) => ({
            select: () => ({
              get: async () => {
                const appId = f.match(/'([^']+)'/)?.[1] ?? "";
                const id = pages.spByAppId?.[appId];
                return { value: id ? [{ id }] : [] };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected api ${path}`);
    });
    return { api, appCall: () => appCall };
  }

  const ctxBase = {
    makeId: (a: string, t: string, e: string) => `${a}:${t}:${e}`,
    now: () => "2024-01-01T00:00:00Z",
    tenantId: "t1",
  };

  it("lists apps, follows nextLink, and resolves SPs", async () => {
    const { api } = graphMock({
      apps: [{ id: "obj-1", appId: "app-1", displayName: "App One" }],
      nextLink: "https://graph.microsoft.com/v1.0/applications?$skiptoken=2",
      secondPage: [{ id: "obj-2", appId: "app-2", displayName: "App Two" }],
      spByAppId: { "app-1": "sp-1" },
    });
    const out = await listAppRegistrations({ ...ctxBase, graphClient: { api } as never }, "acct");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      externalId: "obj-1",
      fields: { appId: "app-1", servicePrincipalId: "sp-1" },
    });
    expect(out[1]!.fields["servicePrincipalId"]).toBe("");
  });

  describe("reading every page", () => {
    const NEXT = "https://graph.microsoft.com/v1.0/applications?$skiptoken=2";
    const APP = { id: "o", appId: "a", displayName: "A" };

    function pagedGraph(first: () => unknown, later: (url: string) => unknown) {
      const top = vi.fn();
      const api = vi.fn((path: string) => {
        if (path === "/applications") {
          top.mockReturnValue({ select: () => ({ get: async () => first() }) });
          return { top };
        }
        if (path === "/servicePrincipals") {
          return { filter: () => ({ select: () => ({ get: async () => ({ value: [] }) }) }) };
        }
        return { get: async () => later(path) };
      });
      const list = () =>
        listAppRegistrations({ ...ctxBase, graphClient: { api } as never }, "acct");
      return { api, top, list };
    }

    it("fails the list on a later page that fails, rather than returning the rest", async () => {
      const { list } = pagedGraph(
        () => ({ value: [APP], "@odata.nextLink": NEXT }),
        () => Promise.reject(new Error("page boom")),
      );
      await expect(list()).rejects.toThrow("page boom");
    });

    it("asks for the largest page Graph documents", async () => {
      const { top, list } = pagedGraph(
        () => ({ value: [] }),
        () => ({ value: [] }),
      );
      await list();
      expect(top).toHaveBeenCalledWith(999);
    });

    it("refuses a first page that is not a list", async () => {
      const { list } = pagedGraph(
        () => ({ apps: [APP] }),
        () => ({ value: [] }),
      );
      await expect(list()).rejects.toThrow("is not a list");
    });

    it("refuses a later page that is not a list", async () => {
      const { list } = pagedGraph(
        () => ({ value: [APP], "@odata.nextLink": NEXT }),
        () => ({ apps: [] }),
      );
      await expect(list()).rejects.toThrow("is not a list");
    });

    it("does not send the token to another host", async () => {
      const evil = "https://evil.example/v1.0/applications?$skiptoken=2";
      const { api, list } = pagedGraph(
        () => ({ value: [APP], "@odata.nextLink": evil }),
        () => {
          throw new Error("reached the foreign host");
        },
      );
      await expect(list()).rejects.toThrow("Refusing to send the account's credentials there");
      expect(api).not.toHaveBeenCalledWith(evil);
    });

    it("refuses past the page cap, at the 100,000 row ceiling", async () => {
      let n = 0;
      const next = () => ({
        value: [APP],
        "@odata.nextLink": `${NEXT}${n++}`,
      });
      const { api, list } = pagedGraph(next, next);
      await expect(list()).rejects.toThrow("has more than Infrawrench reads");
      // The first page goes through the query builder, the rest by their links.
      const linked = api.mock.calls.filter(([path]) => path.startsWith("https://"));
      expect(linked).toHaveLength(100);
    });
  });

  it("ignores SP lookup failures", async () => {
    const api = vi.fn((path: string) => {
      if (path === "/applications") {
        return {
          top: () => ({
            select: () => ({
              get: async () => ({ value: [{ id: "o", appId: "a", displayName: "A" }] }),
            }),
          }),
        };
      }
      return {
        filter: () => ({
          select: () => ({ get: async () => Promise.reject(new Error("sp boom")) }),
        }),
      };
    });
    const out = await listAppRegistrations({ ...ctxBase, graphClient: { api } as never }, "acct");
    expect(out[0]!.fields["servicePrincipalId"]).toBe("");
  });
});

describe("makeGraphClient", () => {
  it("builds a client whose authProvider resolves the token", async () => {
    const graphToken = vi.fn(async () => "graph-tok");
    const client = makeGraphClient({ graphToken });
    expect(client).toBeDefined();
    // Drive the configured authProvider directly to confirm token wiring.
    const config = (
      client as unknown as {
        config: { authProvider: (cb: (e: Error | null, t: string | null) => void) => void };
      }
    ).config;
    const token = await new Promise<string | null>((resolve, reject) => {
      config.authProvider((err, t) => (err ? reject(err) : resolve(t)));
    });
    expect(token).toBe("graph-tok");
    expect(graphToken).toHaveBeenCalled();
  });

  it("propagates token errors to the auth callback", async () => {
    const client = makeGraphClient({ graphToken: async () => Promise.reject(new Error("no tok")) });
    const config = (
      client as unknown as {
        config: { authProvider: (cb: (e: Error | null, t: string | null) => void) => void };
      }
    ).config;
    await expect(
      new Promise((resolve, reject) => {
        config.authProvider((err, t) => (err ? reject(err) : resolve(t)));
      }),
    ).rejects.toThrow(/no tok/);
  });
});
