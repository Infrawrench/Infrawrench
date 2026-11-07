import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it } from "vitest";
import { ConsulApiError, normaliseAddress } from "../api.js";
import { ConsulClient, configTemplate, pickerList } from "../client.js";
import { consulTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return {
    c: hostClient(
      new ConsulClient({ address: "consul.internal:8500/ui/", token: "tok", ...creds }, {
        http,
      } as never),
    ),
    calls,
  };
}

describe("helpers", () => {
  it("normalises the address", () => {
    expect(normaliseAddress("consul.internal:8500/ui/dc1/services")).toBe(
      "http://consul.internal:8500",
    );
    expect(normaliseAddress("consul.example.com:8501")).toBe("https://consul.example.com:8501");
  });

  it("builds starter config entries", () => {
    expect(JSON.parse(configTemplate("service-defaults", "web"))).toEqual({
      Kind: "service-defaults",
      Name: "web",
      Protocol: "http",
    });
    expect(JSON.parse(configTemplate("proxy-defaults", "x")).Name).toBe("global");
  });

  it("reads picker values", () => {
    expect(pickerList('["a","b"]')).toBe("a,b");
    expect(pickerList("a, b")).toBe("a, b");
  });
});

describe("requests", () => {
  it("sends the token and scopes, and counts check states per service", async () => {
    const { c, calls } = client(
      (call) =>
        call.url.pathname === "/v1/catalog/services"
          ? { web: ["v1"], consul: [] }
          : [
              { Node: "n1", CheckID: "a", ServiceName: "web", Status: "critical" },
              { Node: "n1", CheckID: "b", ServiceName: "web", Status: "passing" },
            ],
      { datacenter: "dc2", namespace: "team" },
    );
    const svcs = await c.listResources("consul-service", ACCOUNT);
    expect(calls[0]!.headers["X-Consul-Token"]).toBe("tok");
    expect(calls[0]!.url.search).toBe("?dc=dc2&ns=team");
    const web = svcs.find((s) => s.displayName === "web")!;
    expect(web.fields).toMatchObject({ critical: 1, passing: 1, tags: "v1" });
  });

  it("lists KV keys with a bare ?keys flag and pages them", async () => {
    const { c, calls } = client(() => ["app/a", "app/b", "app/c"]);
    const page = await c.listKvKeys("consul-cluster", "acct:consul-cluster:cluster", ACCOUNT, {
      prefix: "app/",
      limit: 2,
    });
    expect(calls[0]!.url.pathname).toBe("/v1/kv/app/");
    expect(calls[0]!.url.search).toBe("?keys");
    expect(page).toEqual({ items: [{ name: "app/a" }, { name: "app/b" }], nextCursor: "2" });
  });

  it("writes KV values as a raw body", async () => {
    const { c, calls } = client(() => true);
    await c.putKvValue("consul-cluster", "x", ACCOUNT, "app/config json", '{"a":1}');
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/v1/kv/app/config%20json");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/octet-stream");
    expect(calls[0]!.body).toEqual({ a: 1 });
  });

  it("upserts intentions by name and keeps L7 permissions on edit", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET"
        ? {
            SourceName: "web",
            DestinationName: "db",
            Permissions: [{ Action: "allow" }],
            SourceType: "consul",
          }
        : true,
    );
    await c.updateResource("consul-intention", "acct:consul-intention:web/db", ACCOUNT, {
      description: "x",
    });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.url.search).toBe("?source=web&destination=db");
    expect(put.body).toEqual({
      SourceType: "consul",
      Permissions: [{ Action: "allow" }],
      Description: "x",
    });
  });

  it("applies a config entry with check-and-set and refuses renames", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET" ? { Kind: "service-defaults", Name: "web", ModifyIndex: 7 } : true,
    );
    await c.applyManifest(
      "acct:consul-config-entry:service-defaults/web",
      ACCOUNT,
      '{"Kind":"service-defaults","Name":"web","Protocol":"grpc"}',
    );
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.url.searchParams.get("cas")).toBe("7");
    await expect(
      c.applyManifest(
        "acct:consul-config-entry:service-defaults/web",
        ACCOUNT,
        '{"Kind":"service-defaults","Name":"api"}',
      ),
    ).rejects.toThrow(/must stay/);
  });

  it("reads Enterprise-only lists as empty on Community Edition", async () => {
    const { c } = client(() => ({ status: 404, text: "Not found" }));
    expect(await c.listResources("consul-namespace", ACCOUNT)).toEqual([]);
    expect(await c.listResources("consul-partition", ACCOUNT)).toEqual([]);
  });

  it("refuses to delete the token it uses", async () => {
    const { c } = client(() => ({ AccessorID: "me" }));
    const err = await c
      .deleteResource("consul-acl-token", "acct:consul-acl-token:me")
      .catch((e: unknown) => e);
    expect((err as ConsulApiError).status).toBe(400);
  });

  it("keeps a generated peering token as a secret", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/v1/peering/token"
        ? { PeeringToken: "tok123" }
        : { Name: "cluster-02", State: "PENDING" },
    );
    const r = await c.createResource("consul-peering", ACCOUNT, {
      name: "cluster-02",
      mode: "generate",
    });
    expect(r.secretStates[0]).toEqual({
      fieldKey: "peeringToken",
      resolution: { kind: "plaintext", value: "tok123" },
    });
  });
});

describe("lists a sync prunes against", () => {
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  });
  const trackUnread = () => {
    const parts: Array<{ idPrefixes?: readonly string[] }> = [];
    Reflect.set(globalThis, UNREAD_HOOK, (part: { idPrefixes?: readonly string[] }) =>
      parts.push(part),
    );
    return parts;
  };
  const denied = {
    status: 403,
    text: "Permission denied: token with AccessorID 'x' lacks permission 'acl:read'",
  };
  const badToken = { status: 403, text: "ACL not found" };

  const checks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ Node: "n1", CheckID: `c${i}`, Status: "passing" }));
  const policies = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ID: `p${i}`, Name: `policy-${i}` }));

  describe("checks", () => {
    it("reads past the old cap of 3,000", async () => {
      const { c } = client(() => checks(3001));
      expect(await c.listResources("consul-check", ACCOUNT)).toHaveLength(3001);
    });

    it("throws past the row ceiling rather than return part of the list", async () => {
      const { c } = client(() => checks(100_001));
      await expect(c.listResources("consul-check", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });
  });

  describe("ACL policies", () => {
    const route = (n: number) => (call: Call) =>
      call.url.pathname === "/v1/acl/policies"
        ? policies(n)
        : { ID: call.url.pathname.split("/").pop(), Name: "x", Rules: "node_prefix {}" };

    it("keeps every policy past the old cap of 300, each with its rules", async () => {
      const { c } = client(route(301));
      const rows = await c.listResources("consul-acl-policy", ACCOUNT);
      expect(rows).toHaveLength(301);
      expect(rows[300]!.resolvedOutputs["rules"]).toBe("node_prefix {}");
    });

    it("keeps a policy past the rules budget, without its rules, and reads no further", async () => {
      const { c, calls } = client(route(1001));
      const rows = await c.listResources("consul-acl-policy", ACCOUNT);
      expect(rows).toHaveLength(1001);
      expect(rows[999]!.resolvedOutputs["rules"]).toBe("node_prefix {}");
      expect(rows[1000]!.externalId).toBe("p1000");
      expect(rows[1000]!.resolvedOutputs["rules"]).toBeUndefined();
      expect(calls.filter((x) => x.url.pathname.startsWith("/v1/acl/policy/"))).toHaveLength(1000);
    });

    it("does not open more connections than an agent allows one client", async () => {
      const { http } = makeHttp(route(300));
      let open = 0;
      let peak = 0;
      const request: typeof http.request = async (req) => {
        open++;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 0));
        open--;
        return http.request(req);
      };
      const c = hostClient(
        new ConsulClient({ address: "consul.internal:8500", token: "tok" }, {
          http: { request },
        } as never),
      );
      await c.listResources("consul-acl-policy", ACCOUNT);
      expect(peak).toBeLessThanOrEqual(20);
    });

    it("fails the type when reading a policy's rules fails, so its stored rules stay", async () => {
      const { c } = client((call) =>
        call.url.pathname === "/v1/acl/policies" ? policies(2) : { status: 500, text: "boom" },
      );
      await expect(c.listResources("consul-acl-policy", ACCOUNT)).rejects.toThrow("500");
    });

    it.each([404, 403])(
      "keeps the listed row when a policy went away between the two reads (%i)",
      async (status) => {
        const { c } = client((call) =>
          call.url.pathname === "/v1/acl/policies"
            ? policies(1)
            : { status, text: "ACL not found" },
        );
        const rows = await c.listResources("consul-acl-policy", ACCOUNT);
        expect(rows.map((r) => r.externalId)).toEqual(["p0"]);
      },
    );

    it("reads the rules on the detail view when the listed row has none", async () => {
      const { c } = client(() => ({ ID: "p1", Name: "x", Rules: "node_prefix {}" }));
      const row = (await c.enrichDetail!({
        id: `${ACCOUNT}:consul-acl-policy:p1`,
        pluginId: "consul",
        resourceTypeId: "consul-acl-policy",
        accountId: ACCOUNT,
        displayName: "x",
        externalId: "p1",
        fields: {},
        resolvedOutputs: { id: "p1" },
        secretStates: [],
        createdAt: "",
        updatedAt: "",
      }))!;
      expect(row.resolvedOutputs["rules"]).toBe("node_prefix {}");
    });
  });

  describe("config entries", () => {
    const kindOf = (call: Call) => call.url.pathname.replace("/v1/config/", "");

    it("fails the type when one kind's read fails, rather than read that kind as none", async () => {
      const { c } = client((call) =>
        kindOf(call) === "service-router"
          ? { status: 500, text: "rpc error making call: No cluster leader" }
          : [],
      );
      await expect(c.listResources("consul-config-entry", ACCOUNT)).rejects.toThrow("500");
    });

    it("fails the type on a throttle", async () => {
      const { c } = client((call) =>
        kindOf(call) === "mesh" ? { status: 429, text: "rate limit exceeded" } : [],
      );
      await expect(c.listResources("consul-config-entry", ACCOUNT)).rejects.toThrow("429");
    });

    it("reads a kind this server does not know as none", async () => {
      // Community Edition has no control-plane-request-limit, and answers 500 for it.
      const { c } = client((call) =>
        kindOf(call) === "control-plane-request-limit"
          ? { status: 500, text: "invalid config entry kind: control-plane-request-limit" }
          : kindOf(call) === "service-defaults"
            ? [{ Kind: "service-defaults", Name: "web" }]
            : [],
      );
      const rows = await c.listResources("consul-config-entry", ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["service-defaults/web"]);
    });

    it("keeps a refused kind's rows and reads the others", async () => {
      const parts = trackUnread();
      const { c } = client((call) =>
        kindOf(call) === "exported-services"
          ? denied
          : kindOf(call) === "service-defaults"
            ? [{ Kind: "service-defaults", Name: "web" }]
            : [],
      );
      const rows = await c.listResources("consul-config-entry", ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["service-defaults/web"]);
      expect(parts).toEqual([
        { idPrefixes: [`${ACCOUNT}:consul-config-entry:exported-services/`] },
      ]);
    });

    it("shows a refused kind where the host keeps no track", async () => {
      const { c } = client((call) => (kindOf(call) === "exported-services" ? denied : []));
      await expect(c.listResources("consul-config-entry", ACCOUNT)).rejects.toThrow("403");
    });

    it("fails on a token that does not exist", async () => {
      trackUnread();
      const { c } = client(() => badToken);
      await expect(c.listResources("consul-config-entry", ACCOUNT)).rejects.toThrow("403");
    });
  });

  describe("a token refused a whole type", () => {
    it("keeps the rows without an error", async () => {
      const parts = trackUnread();
      const { c } = client(() => denied);
      expect(await c.listResources("consul-acl-token", ACCOUNT)).toEqual([]);
      expect(parts).toEqual([{ idPrefixes: [""] }]);
    });

    it("still shows where the host keeps no track", async () => {
      const { c } = client(() => denied);
      await expect(c.listResources("consul-acl-token", ACCOUNT)).rejects.toThrow("403");
    });

    it("does not cover a token Consul does not recognise", async () => {
      const parts = trackUnread();
      const { c } = client(() => badToken);
      await expect(c.listResources("consul-acl-token", ACCOUNT)).rejects.toThrow("403");
      expect(parts).toEqual([]);
    });
  });

  describe("an answer that is not a list", () => {
    const LISTS: Array<[string, string]> = [
      ["consul-node", "/v1/catalog/nodes"],
      ["consul-check", "/v1/health/state/any"],
      ["consul-intention", "/v1/connect/intentions"],
      ["consul-acl-policy", "/v1/acl/policies"],
      ["consul-acl-role", "/v1/acl/roles"],
      ["consul-acl-token", "/v1/acl/tokens"],
      ["consul-session", "/v1/session/list"],
      ["consul-peering", "/v1/peerings"],
      ["consul-namespace", "/v1/namespaces"],
      ["consul-partition", "/v1/partitions"],
    ];

    it.each(LISTS)("%s rejects an object, HTML and no body", async (typeId, path) => {
      for (const reply of [
        { body: { error: "wrapped" } },
        { text: "<html>sign in</html>" },
        { text: "" },
      ]) {
        const { c } = client((call) => (call.url.pathname === path ? reply : []));
        await expect(c.listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
      }
    });

    it.each(LISTS)("%s reads a bare null as empty, how Go encodes a nil slice", async (typeId) => {
      const { c } = client(() => ({ text: "null" }));
      expect(await c.listResources(typeId, ACCOUNT)).toEqual([]);
    });

    it("a config kind rejects one too", async () => {
      const { c } = client((call) =>
        call.url.pathname === "/v1/config/mesh" ? { text: "<html>sign in</html>" } : [],
      );
      await expect(c.listResources("consul-config-entry", ACCOUNT)).rejects.toThrow(
        "is not a list",
      );
    });

    it("the service map rejects HTML, which would read as one row per character", async () => {
      for (const reply of [{ text: "<html>" }, { text: "" }, { body: ["web"] }]) {
        const { c } = client((call) => (call.url.pathname === "/v1/catalog/services" ? reply : []));
        await expect(c.listResources("consul-service", ACCOUNT)).rejects.toThrow("is not a list");
      }
    });

    it("the service map reads a bare null as empty", async () => {
      const { c } = client(() => ({ text: "null" }));
      expect(await c.listResources("consul-service", ACCOUNT)).toEqual([]);
    });
  });
});

describe("terraform", () => {
  it("exports a config entry with its body as config_json", () => {
    const out = consulTerraformExport.mapResource({
      id: "acct:consul-config-entry:service-defaults/web",
      pluginId: "consul",
      resourceTypeId: "consul-config-entry",
      accountId: ACCOUNT,
      displayName: "service-defaults/web",
      externalId: "service-defaults/web",
      fields: { kind: "service-defaults", name: "web" },
      resolvedOutputs: { config: '{"Protocol":"http"}' },
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.importId).toBe("service-defaults/web");
    expect(out?.resource.attributes["config_json"]).toEqual({
      kind: "string",
      value: '{"Protocol":"http"}',
    });
  });
});
