import { describe, expect, it } from "vitest";
import { ConsulApiError, normaliseAddress } from "../api.js";
import { ConsulClient, configTemplate, pickerList } from "../client.js";
import { consulTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return {
    c: new ConsulClient({ address: "consul.internal:8500/ui/", token: "tok", ...creds }, {
      http,
    } as never),
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
