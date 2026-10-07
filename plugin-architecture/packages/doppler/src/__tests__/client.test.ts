import { describe, expect, it } from "vitest";
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
  return { c: new DopplerClient({ token: "dp.pt.x" }, { http } as never), calls };
}

describe("helpers", () => {
  it("recognises token formats and refuses service tokens", () => {
    expect(tokenKind("dp.sa.abc")).toBe("service-account");
    expect(() => new DopplerClient({ token: "dp.st.dev.abc" })).toThrow(/service token/);
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
