import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DopplerApiError, tokenKind } from "../api.js";
import { DopplerClient } from "../client.js";
import { mapConfig, splitId } from "../mappers.js";
import { mapComponent } from "../status-feed.js";
import { dopplerTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  return { c: hostClient(new DopplerClient({ token: "dp.pt.x" }, { http } as never)), calls };
}

describe("helpers", () => {
  it("recognises token formats and refuses service tokens", () => {
    expect(tokenKind("dp.sa.abc")).toBe("service-account");
    expect(() => hostClient(new DopplerClient({ token: "dp.st.dev.abc" }))).toThrow(
      /service token/,
    );
  });

  it("splits nested ids", () => {
    expect(splitId("backend.dev_feature.DATABASE_URL", 3)).toEqual([
      "backend",
      "dev_feature",
      "DATABASE_URL",
    ]);
    expect(() => splitId("backend", 2)).toThrow();
  });
});

describe("requests", () => {
  it("sends a Bearer token and pages until a short page", async () => {
    const { c, calls } = client((call) => {
      const page = Number(call.url.searchParams.get("page"));
      const n = page === 1 ? 100 : 3;
      return {
        projects: Array.from({ length: n }, (_, i) => ({
          id: `p${page}-${i}`,
          slug: `p${page}-${i}`,
          name: `P ${i}`,
        })),
      };
    });
    const projects = await c.listResources("doppler-project", ACCOUNT);
    expect(projects).toHaveLength(103);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer dp.pt.x");
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
  });

  it("maps errors with their status and messages", async () => {
    const { c } = client(() => ({
      status: 403,
      body: { messages: ["You do not have access"], success: false },
    }));
    const err = await c.listResources("doppler-integration", ACCOUNT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DopplerApiError);
    expect((err as DopplerApiError).status).toBe(403);
    expect((err as Error).message).toContain("You do not have access");
  });

  it("walks workplace users until an empty page", async () => {
    const { c, calls } = client((call) =>
      call.url.searchParams.get("page") === "1"
        ? { workplace_users: [{ id: "u1", access: "owner", user: { email: "a@example.com" } }] }
        : { workplace_users: [] },
    );
    const users = await c.listResources("doppler-user", ACCOUNT);
    expect(users[0]!.fields).toMatchObject({ email: "a@example.com", access: "owner" });
    expect(calls[0]!.url.searchParams.has("per_page")).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("configs and secrets", () => {
  const route = (call: Call) => {
    const p = call.url.pathname;
    if (p === "/v3/projects") return { projects: [{ id: "x1", slug: "backend", name: "Backend" }] };
    if (p === "/v3/configs")
      return { configs: [{ name: "dev", root: true, environment: "dev", project: "backend" }] };
    if (p === "/v3/configs/config/secrets" && call.method === "GET")
      return {
        secrets: {
          DB: {
            raw: "${USER}@db",
            computed: "app@db",
            note: "primary",
            rawVisibility: { type: "restricted" },
          },
          USER: { raw: "app", computed: "app", note: "" },
        },
      };
    if (p === "/v3/configs/config/secret" && call.method === "GET")
      return { name: "USER", value: { raw: "app", computed: "app" } };
    if (p === "/v3/configs/config/secrets/names") return { names: ["USER", "DB"] };
    return {};
  };

  it("lists secrets without keeping their values", async () => {
    const { c } = client(route);
    const secrets = await c.listResources("doppler-secret", ACCOUNT);
    expect(secrets.map((s) => s.externalId)).toEqual(["backend.dev.DB", "backend.dev.USER"]);
    expect(secrets[0]!.fields).toMatchObject({
      visibility: "restricted",
      note: "primary",
      referencesOthers: true,
    });
    expect(JSON.stringify(secrets)).not.toContain("app@db");
    expect(secrets[0]!.parentResourceId).toBe(`${ACCOUNT}:doppler-config:backend.dev`);
  });

  it("edits secrets through the Keys tab", async () => {
    const { c, calls } = client(route);
    const id = `${ACCOUNT}:doppler-config:backend.dev`;
    expect((await c.listKvKeys("doppler-config", id, ACCOUNT)).items.map((i) => i.name)).toEqual([
      "DB",
      "USER",
    ]);
    expect(await c.getKvValue("doppler-config", id, ACCOUNT, "USER")).toBe("app");
    await c.putKvValue("doppler-config", id, ACCOUNT, "NEW_KEY", "v");
    await c.deleteKvKey("doppler-config", id, ACCOUNT, "USER");
    const writes = calls.filter((x) => x.method !== "GET");
    expect(writes[0]!.body).toEqual({
      project: "backend",
      config: "dev",
      secrets: { NEW_KEY: "v" },
    });
    expect(`${writes[1]!.method} ${writes[1]!.url.search}`).toBe(
      "DELETE ?project=backend&config=dev&name=USER",
    );
    await expect(c.putKvValue("doppler-config", id, ACCOUNT, "bad-key", "v")).rejects.toThrow(
      /letters, digits/,
    );
  });

  it("changes visibility with a change request and leaves the value alone", async () => {
    const { c, calls } = client(route);
    await c.updateResource(
      "doppler-secret",
      `${ACCOUNT}:doppler-secret:backend.dev.USER`,
      ACCOUNT,
      { visibility: "restricted", note: "n" },
    );
    const writes = calls.filter((x) => x.method === "POST");
    expect(writes[0]!.body).toEqual({
      project: "backend",
      config: "dev",
      change_requests: [
        { name: "USER", originalName: "USER", value: null, visibility: "restricted" },
      ],
    });
    expect(writes[1]!.url.pathname).toBe("/v3/projects/project/note");
    expect(writes[1]!.body).toEqual({ secret: "USER", note: "n" });
  });

  it("resolves a secret's computed value as an output", async () => {
    const { c } = client(() => ({ value: { raw: "${A}", computed: "expanded" } }));
    expect(
      await c.resolveOutput(
        "doppler-secret",
        `${ACCOUNT}:doppler-secret:backend.dev.DB`,
        "value",
        ACCOUNT,
      ),
    ).toBe("expanded");
  });

  it("creates a service token and keeps its key", async () => {
    const { c, calls } = client(() => ({
      token: { slug: "t1", name: "ci", key: "dp.st.dev.secret", access: "read", expires_at: null },
    }));
    const r = await c.createResource("doppler-service-token", ACCOUNT, {
      projectConfig: "backend.dev",
      name: "ci",
      access: "read",
    });
    expect(calls[0]!.body).toEqual({
      project: "backend",
      config: "dev",
      name: "ci",
      access: "read",
    });
    expect(r.externalId).toBe("backend.dev.t1");
    expect(r.secretStates[0]?.resolution).toEqual({ kind: "plaintext", value: "dp.st.dev.secret" });
  });
});

describe("groups, webhooks, logs", () => {
  it("adds and removes group members by email", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/v3/workplace/users")
        return call.url.searchParams.get("page") === "1"
          ? {
              workplace_users: [
                { id: "u1", user: { email: "a@x.com" } },
                { id: "u2", user: { email: "b@x.com" } },
              ],
            }
          : { workplace_users: [] };
      if (call.method === "GET")
        return {
          group: { slug: "g1", name: "eng", members: [{ type: "workplace_user", slug: "u1" }] },
        };
      return {};
    });
    await c.updateResource("doppler-group", `${ACCOUNT}:doppler-group:g1`, ACCOUNT, {
      members: "b@x.com",
    });
    const writes = calls.filter((x) => x.method === "POST" || x.method === "DELETE");
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual([
      "POST /v3/workplace/groups/group/g1/members",
      "DELETE /v3/workplace/groups/group/g1/members/workplace_user/u1",
    ]);
    expect(writes[0]!.body).toEqual({ type: "workplace_user", slug: "u2" });
  });

  it("diffs webhook configs", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET"
        ? { webhook: { id: "w1", url: "https://x", enabledConfigs: ["dev", "stg"] } }
        : {},
    );
    await c.updateResource("doppler-webhook", `${ACCOUNT}:doppler-webhook:backend.w1`, ACCOUNT, {
      enabledConfigs: "stg, prd",
    });
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.url.search).toBe("?project=backend");
    expect(patch.body).toEqual({ enableConfigs: ["prd"], disableConfigs: ["dev"] });
  });

  it("renders the activity log oldest first", async () => {
    const { c } = client(() => ({
      logs: [
        {
          id: "2",
          text: "second",
          created_at: "2026-10-02T00:00:00Z",
          user: { email: "a@x.com" },
          project: "backend",
        },
        { id: "1", text: "first", created_at: "2026-10-01T00:00:00Z", user: null },
      ],
    }));
    const logs = await c.getLogs("doppler-workplace", `${ACCOUNT}:doppler-workplace:w`, ACCOUNT, {
      tailLines: 50,
    });
    expect(logs.text.split("\n")[0]).toBe("2026-10-01T00:00:00Z  system  first");
  });
});

describe("status feed and terraform", () => {
  it("maps status components", () => {
    expect(mapComponent("API (api.doppler.com)")?.providerWide).toBe(true);
    expect(mapComponent("AWS Secrets Manager")?.resourceTypes).toContain("doppler-sync");
    expect(mapComponent("Stripe API")).toBeNull();
  });

  it("exports branch configs but not root configs", () => {
    const branch = mapConfig(ACCOUNT, "backend", {
      name: "dev_feature",
      root: false,
      environment: "dev",
    });
    expect(dopplerTerraformExport.mapResource(branch)?.resource.importId).toBe(
      "backend.dev.dev_feature",
    );
    const root = mapConfig(ACCOUNT, "backend", { name: "dev", root: true, environment: "dev" });
    expect(dopplerTerraformExport.mapResource(root)).toBeNull();
  });
});

describe("a list that cannot be read whole", () => {
  const CAP = /has more than Infrawrench reads/;
  const NOT_A_LIST = /is not a list/;
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  const FAILURE = { status: 500, body: { messages: ["boom"], success: false } };
  const REFUSED = { status: 403, body: { messages: ["You do not have access"], success: false } };

  /** Records what a list names as unread, as a sync's host does. */
  function trackUnread() {
    const parts: Array<{ parentResourceIds?: string[]; idPrefixes?: string[] }> = [];
    Reflect.set(globalThis, UNREAD_HOOK, (part: (typeof parts)[number]) => parts.push(part));
    return parts;
  }

  const count = (calls: Call[], path: string) =>
    calls.filter((call) => call.url.pathname === path).length;

  const fullPage = (key: string, prefix: string) => ({
    [key]: Array.from({ length: 100 }, (_, i) => ({
      id: `${prefix}${i}`,
      slug: `${prefix}${i}`,
      name: `${prefix}${i}`,
    })),
  });

  /** One project, `backend`, with these configs. */
  const withConfigs =
    (names: string[], rest: (call: Call) => unknown) =>
    (call: Call): unknown => {
      if (call.url.pathname === "/v3/projects")
        return { projects: [{ id: "p", slug: "backend", name: "Backend" }] };
      if (call.url.pathname === "/v3/configs")
        return call.url.searchParams.get("page") === "1"
          ? { configs: names.slice(0, 100).map((name) => ({ name, project: "backend" })) }
          : { configs: names.slice(100).map((name) => ({ name, project: "backend" })) };
      return rest(call);
    };

  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    vi.restoreAllMocks();
  });

  describe("pages", () => {
    it.each([
      ["doppler-project", "/v3/projects", "projects"],
      ["doppler-group", "/v3/workplace/groups", "groups"],
      ["doppler-service-account", "/v3/workplace/service_accounts", "service_accounts"],
    ])("fails %s past 10,000 rows rather than prune the rest", async (type, path, key) => {
      const { c, calls } = client((call) =>
        call.url.pathname === path
          ? fullPage(key, `p${call.url.searchParams.get("page")}-`)
          : { group: {} },
      );
      await expect(c.listResources(type, ACCOUNT)).rejects.toThrow(CAP);
      expect(count(calls, path)).toBe(100);
    });

    it("reads more than the 2,000 rows the old cap stopped at", async () => {
      const { c } = client((call) => {
        const page = Number(call.url.searchParams.get("page"));
        return page <= 30 ? fullPage("projects", `p${page}-`) : { projects: [] };
      });
      expect(await c.listResources("doppler-project", ACCOUNT)).toHaveLength(3000);
    });

    it("fails workplace users, which have no page size, at their own cap", async () => {
      const { c, calls } = client(() => ({
        workplace_users: [{ id: "u", access: "owner", user: { email: "a@example.com" } }],
      }));
      await expect(c.listResources("doppler-user", ACCOUNT)).rejects.toThrow(CAP);
      expect(calls).toHaveLength(500);
    });

    it("refuses a page with its key renamed, on the first page and on a later one", async () => {
      const first = client(() => ({ items: [] }));
      await expect(first.c.listResources("doppler-project", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
      const later = client((call) =>
        call.url.searchParams.get("page") === "1"
          ? fullPage("projects", "p-")
          : { messages: ["try again"], success: false },
      );
      await expect(later.c.listResources("doppler-project", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
    });

    it.each([
      ["doppler-environment", "/v3/environments"],
      ["doppler-service-token", "/v3/configs/config/tokens"],
      ["doppler-webhook", "/v3/webhooks"],
      ["doppler-secret", "/v3/configs/config/secrets"],
    ])("refuses %s when the answer has no list", async (type, path) => {
      const { c } = client(
        withConfigs(["dev"], (call) => {
          if (call.url.pathname === path) return { messages: ["try again"], success: false };
          throw new Error(`unexpected ${call.url.pathname}`);
        }),
      );
      await expect(c.listResources(type, ACCOUNT)).rejects.toThrow(NOT_A_LIST);
    });

    it.each(["doppler-integration", "doppler-sync"])(
      "refuses %s when the answer has no list",
      async (type) => {
        const { c } = client(() => ({ messages: ["try again"], success: false }));
        await expect(c.listResources(type, ACCOUNT)).rejects.toThrow(NOT_A_LIST);
      },
    );

    it("does not read a workplace answer with no workplace as no workplace", async () => {
      const { c } = client(() => ({ messages: ["try again"], success: false }));
      await expect(c.listResources("doppler-workplace", ACCOUNT)).rejects.toThrow(NOT_A_LIST);
    });

    it("reads a config with no secrets as none", async () => {
      const { c } = client(withConfigs(["dev"], () => ({ secrets: {}, success: true })));
      expect(await c.listResources("doppler-secret", ACCOUNT)).toEqual([]);
    });
  });

  describe("secrets, one request per config", () => {
    const names = Array.from({ length: 150 }, (_, i) => `c${i}`);
    const configId = (name: string) => `${ACCOUNT}:doppler-config:backend.${name}`;
    const secretRoute = withConfigs(names, (call) => ({
      secrets: { [`${call.url.searchParams.get("config")}_KEY`]: { raw: "v", computed: "v" } },
    }));

    it("reads 100 configs a poll from a random start and names the rest", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const parts = trackUnread();
      const { c, calls } = client(secretRoute);
      const rows = await c.listResources("doppler-secret", ACCOUNT);
      expect(count(calls, "/v3/configs/config/secrets")).toBe(100);
      expect(rows).toHaveLength(100);
      const read = new Set(rows.map((r) => r.parentResourceId));
      // Starts at 135 of 150 and wraps, so the ones nearest the end of the list get read too.
      expect(read.has(configId("c149"))).toBe(true);
      expect(read.has(configId("c0"))).toBe(true);
      expect(read.has(configId("c84"))).toBe(true);
      expect(read.has(configId("c85"))).toBe(false);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.parentResourceIds).toHaveLength(50);
      expect(parts[0]!.parentResourceIds).toContain(configId("c85"));
      expect(parts[0]!.parentResourceIds).not.toContain(configId("c0"));
    });

    it("names nothing when every config fits", async () => {
      const parts = trackUnread();
      const { c } = client(withConfigs(["dev", "stg"], () => ({ secrets: { A: { raw: "v" } } })));
      expect(await c.listResources("doppler-secret", ACCOUNT)).toHaveLength(2);
      expect(parts).toEqual([]);
    });

    it("names the configs left past the row ceiling rather than stopping as if complete", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const parts = trackUnread();
      const big = Object.fromEntries(
        Array.from({ length: 60_000 }, (_, i) => [`K${i}`, { raw: "v" }]),
      );
      const { c, calls } = client(withConfigs(["a", "b", "c"], () => ({ secrets: big })));
      const rows = await c.listResources("doppler-secret", ACCOUNT);
      expect(rows).toHaveLength(120_000);
      expect(count(calls, "/v3/configs/config/secrets")).toBe(2);
      expect(parts).toEqual([{ parentResourceIds: [configId("c")] }]);
    });

    it("keeps a refused config's secrets, reads the others and fails on anything else", async () => {
      const parts = trackUnread();
      const route = (failure: unknown) =>
        withConfigs(["dev", "stg"], (call) =>
          call.url.searchParams.get("config") === "dev"
            ? failure
            : { secrets: { A: { raw: "v" } } },
        );
      const refused = client(route(REFUSED));
      expect(
        (await refused.c.listResources("doppler-secret", ACCOUNT)).map((r) => r.externalId),
      ).toEqual(["backend.stg.A"]);
      expect(parts).toEqual([{ parentResourceIds: [configId("dev")] }]);
      await expect(
        client(route(FAILURE)).c.listResources("doppler-secret", ACCOUNT),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("service account tokens", () => {
    const route = (failure: unknown) => (call: Call) => {
      if (call.url.pathname === "/v3/workplace/service_accounts")
        return call.url.searchParams.get("page") === "1"
          ? {
              service_accounts: [
                { slug: "sa1", name: "One" },
                { slug: "sa2", name: "Two" },
              ],
            }
          : { service_accounts: [] };
      return call.url.pathname.includes("/sa1/")
        ? failure
        : { api_tokens: [{ slug: "t", name: "t" }] };
    };

    it("fails on a failed read rather than drop that account's tokens", async () => {
      trackUnread();
      await expect(
        client(route(FAILURE)).c.listResources("doppler-service-account-token", ACCOUNT),
      ).rejects.toThrow(/boom/);
    });

    it("fails when a token list has more pages than it reads", async () => {
      const { c } = client((call) =>
        call.url.pathname === "/v3/workplace/service_accounts"
          ? { service_accounts: [{ slug: "sa1", name: "One" }] }
          : fullPage("api_tokens", `t${call.url.searchParams.get("page")}-`),
      );
      await expect(c.listResources("doppler-service-account-token", ACCOUNT)).rejects.toThrow(CAP);
    });

    it("keeps a refused account's tokens and reads the others", async () => {
      const parts = trackUnread();
      const rows = await client(route(REFUSED)).c.listResources(
        "doppler-service-account-token",
        ACCOUNT,
      );
      expect(rows.map((r) => r.externalId)).toEqual(["sa2.t"]);
      expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:doppler-service-account:sa1`] }]);
    });
  });

  describe("other lists read per parent", () => {
    it("reads service tokens for 100 configs a poll from a random start and names the rest", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const parts = trackUnread();
      const names = Array.from({ length: 150 }, (_, i) => `c${i}`);
      const configId = (name: string) => `${ACCOUNT}:doppler-config:backend.${name}`;
      const { c, calls } = client(withConfigs(names, () => ({ tokens: [{ slug: "t" }] })));
      const rows = await c.listResources("doppler-service-token", ACCOUNT);
      expect(count(calls, "/v3/configs/config/tokens")).toBe(100);
      const read = new Set(rows.map((r) => r.parentResourceId));
      expect(read.size).toBe(100);
      expect(read.has(configId("c135"))).toBe(true);
      expect(read.has(configId("c84"))).toBe(true);
      expect(read.has(configId("c85"))).toBe(false);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.parentResourceIds).toHaveLength(50);
      expect(parts[0]!.parentResourceIds).toContain(configId("c85"));
      expect(parts[0]!.parentResourceIds).not.toContain(configId("c135"));
    });

    it("reads every config's service tokens and names nothing when they fit", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const parts = trackUnread();
      const names = Array.from({ length: 100 }, (_, i) => `c${i}`);
      const { c, calls } = client(withConfigs(names, () => ({ tokens: [] })));
      await c.listResources("doppler-service-token", ACCOUNT);
      expect(count(calls, "/v3/configs/config/tokens")).toBe(100);
      expect(parts).toEqual([]);
    });

    it("fails service tokens on a failed read and keeps a refused config's", async () => {
      trackUnread();
      await expect(
        client(withConfigs(["dev"], () => FAILURE)).c.listResources(
          "doppler-service-token",
          ACCOUNT,
        ),
      ).rejects.toThrow(/boom/);
      const parts = trackUnread();
      expect(
        await client(withConfigs(["dev"], () => REFUSED)).c.listResources(
          "doppler-service-token",
          ACCOUNT,
        ),
      ).toEqual([]);
      expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:doppler-config:backend.dev`] }]);
    });

    const projectRoute = (failure: unknown) => (call: Call) =>
      call.url.pathname === "/v3/projects"
        ? { projects: [{ id: "p", slug: "backend", name: "Backend" }] }
        : failure;

    it("fails webhooks on a failed read", async () => {
      trackUnread();
      await expect(
        client(projectRoute(FAILURE)).c.listResources("doppler-webhook", ACCOUNT),
      ).rejects.toThrow(/boom/);
    });

    // The document's only error for this route is a 400 with no description.
    it.each([
      [403, REFUSED],
      [400, { status: 400, body: { messages: ["no"], success: false } }],
    ])("keeps a project's webhooks on a %i", async (_status, failure) => {
      const parts = trackUnread();
      expect(
        await client(projectRoute(failure)).c.listResources("doppler-webhook", ACCOUNT),
      ).toEqual([]);
      expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:doppler-project:backend`] }]);
    });

    it("keeps what hangs off a project whose configs are refused, and reads the others", async () => {
      const parts = trackUnread();
      const { c } = client((call) => {
        if (call.url.pathname === "/v3/projects")
          return {
            projects: [
              { id: "a", slug: "a", name: "A" },
              { id: "b", slug: "b", name: "B" },
            ],
          };
        return call.url.searchParams.get("project") === "a"
          ? REFUSED
          : { configs: [{ name: "dev", project: "b" }] };
      });
      const rows = await c.listResources("doppler-config", ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["b.dev"]);
      expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:doppler-project:a`] }]);
    });

    it("shows the refusal where no host tracks it and every parent refused", async () => {
      await expect(
        client(withConfigs(["dev"], () => REFUSED)).c.listResources(
          "doppler-service-token",
          ACCOUNT,
        ),
      ).rejects.toThrow(/You do not have access/);
    });

    it("shows the refusal where no host tracks it and only some parents refused", async () => {
      const { c } = client(
        withConfigs(["dev", "stg"], (call) =>
          call.url.searchParams.get("config") === "dev" ? REFUSED : { tokens: [{ slug: "t" }] },
        ),
      );
      await expect(c.listResources("doppler-service-token", ACCOUNT)).rejects.toThrow(
        /You do not have access/,
      );
    });

    it("reads every config where no host keeps track of the rest", async () => {
      const names = Array.from({ length: 150 }, (_, i) => `c${i}`);
      const { c, calls } = client(withConfigs(names, () => ({ tokens: [{ slug: "t" }] })));
      const rows = await c.listResources("doppler-service-token", ACCOUNT);
      expect(count(calls, "/v3/configs/config/tokens")).toBe(150);
      expect(rows).toHaveLength(150);
    });
  });

  describe("a type the credential is refused", () => {
    it("keeps the rows without an error", async () => {
      const parts = trackUnread();
      expect(await client(() => REFUSED).c.listResources("doppler-user", ACCOUNT)).toEqual([]);
      expect(parts).toEqual([{ idPrefixes: [""] }]);
    });

    it("still fails on a rejected credential, a throttle or a 5xx", async () => {
      const parts = trackUnread();
      for (const status of [401, 429, 500]) {
        await expect(
          client(() => ({ status, body: { messages: ["no"] } })).c.listResources(
            "doppler-user",
            ACCOUNT,
          ),
        ).rejects.toThrow(/no/);
      }
      expect(parts).toEqual([]);
    });

    it("answers a single read with the refusal, not with not found", async () => {
      trackUnread();
      await expect(
        client(() => REFUSED).c.getResource(
          "doppler-workplace",
          `${ACCOUNT}:doppler-workplace:w`,
          ACCOUNT,
        ),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("groups", () => {
    const route =
      (detail: unknown, users: unknown = { workplace_users: [] }) =>
      (call: Call) => {
        if (call.url.pathname === "/v3/workplace/groups")
          return { groups: [{ slug: "g1", name: "eng" }] };
        if (call.url.pathname === "/v3/workplace/users") return users;
        return detail;
      };

    it("fails on a failed detail read rather than blank the group's members", async () => {
      await expect(
        client(route(FAILURE)).c.listResources("doppler-group", ACCOUNT),
      ).rejects.toThrow(/boom/);
    });

    it("keeps the summary when the detail is refused", async () => {
      const rows = await client(route(REFUSED)).c.listResources("doppler-group", ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["g1"]);
    });

    it("shows member ids when users are refused, and fails on any other failure", async () => {
      const detail = {
        group: { slug: "g1", name: "eng", members: [{ type: "workplace_user", slug: "u1" }] },
      };
      const rows = await client(route(detail, REFUSED)).c.listResources("doppler-group", ACCOUNT);
      expect(rows[0]!.fields).toMatchObject({ members: "u1" });
      await expect(
        client(route(detail, FAILURE)).c.listResources("doppler-group", ACCOUNT),
      ).rejects.toThrow(/boom/);
    });

    it("fails when the users behind a group have more pages than it reads", async () => {
      const detail = { group: { slug: "g1", name: "eng", members: [] } };
      const { c } = client(
        route(detail, { workplace_users: [{ id: "u", user: { email: "a@example.com" } }] }),
      );
      await expect(c.listResources("doppler-group", ACCOUNT)).rejects.toThrow(CAP);
    });
  });
});
