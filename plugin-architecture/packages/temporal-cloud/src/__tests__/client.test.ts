import { describe, expect, it } from "vitest";
const encodePromptArgs = (o: Record<string, string>) => [JSON.stringify(o)];
import { TemporalCloudClient } from "../client.js";
import { decodePayload, encodePayload } from "../mappers.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed, regionIdForComponent } from "../status-feed.js";
import { temporalTerraformExport } from "../terraform.js";
import { makeHttp } from "./helpers.js";

const NS = {
  namespace: "prod.a2dd6",
  resourceVersion: "v7",
  state: "RESOURCE_STATE_ACTIVE",
  activeRegion: "aws-us-east-1",
  tags: { team: "core", env: "prod" },
  endpoints: { grpcAddress: "us-east-1.aws.api.temporal.io:7233", webAddress: "https://x" },
  limits: { actionsPerSecondLimit: 500 },
  spec: {
    name: "prod",
    regions: ["aws-us-east-1", "aws-us-west-2"],
    retentionDays: 30,
    apiKeyAuth: { enabled: true },
    searchAttributes: { CustomerId: "SEARCH_ATTRIBUTE_TYPE_KEYWORD" },
    lifecycle: { enableDeleteProtection: true },
  },
};

function client(route: Parameters<typeof makeHttp>[0]) {
  const { http, calls } = makeHttp(route);
  const c = new TemporalCloudClient({ apiKey: "k" }, { http } as never);
  return { c, calls };
}

const nsRoute = (url: URL, method: string) => {
  if (url.pathname === "/cloud/namespaces" && method === "GET")
    return { body: { namespaces: [NS] } };
  if (url.pathname === "/cloud/namespaces/prod.a2dd6" && method === "GET")
    return { body: { namespace: NS } };
  if (method === "POST")
    return { body: { asyncOperation: { id: "op", state: "STATE_FULFILLED" } } };
  return { status: 404, body: {} };
};

describe("TemporalCloudClient", () => {
  it("lists namespaces with the API version header and maps the fields", async () => {
    const { c, calls } = client(nsRoute);
    const [ns] = await c.listResources("namespace", "acc");
    expect(calls[0]?.headers["temporal-cloud-api-version"]).toBe("v0.22.0");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer k");
    expect(ns).toMatchObject({
      id: "acc:namespace:prod.a2dd6",
      displayName: "prod",
      fields: {
        retentionDays: 30,
        regions: "aws-us-east-1, aws-us-west-2",
        multiRegion: true,
        tags: "env=prod, team=core",
        searchAttributes: "CustomerId (Keyword)",
        apsLimit: 500,
        state: "active",
      },
    });
  });

  it("validates retention and sends the full spec with the resource version", async () => {
    const { c, calls } = client(nsRoute);
    await expect(
      c.updateResource("namespace", "acc:namespace:prod.a2dd6", "acc", { retentionDays: "91" }),
    ).rejects.toThrow(/1 to 90/);
    await c.updateResource("namespace", "acc:namespace:prod.a2dd6", "acc", {
      retentionDays: "14",
      tags: "team=payments",
    });
    const update = calls.find(
      (x) => x.method === "POST" && x.url.pathname === "/cloud/namespaces/prod.a2dd6",
    );
    expect(update?.body).toMatchObject({
      resourceVersion: "v7",
      spec: {
        name: "prod",
        retentionDays: 14,
        searchAttributes: { CustomerId: "SEARCH_ATTRIBUTE_TYPE_KEYWORD" },
      },
    });
    const tags = calls.find((x) => x.url.pathname.endsWith("/update-tags"));
    expect(tags?.body).toEqual({ tagsToUpsert: { team: "payments" }, tagsToRemove: ["env"] });
  });

  it("adds a search attribute, refusing duplicates", async () => {
    const { c, calls } = client(nsRoute);
    const id = "acc:namespace:prod.a2dd6";
    await expect(
      c.executeNoSqlCommand(
        "namespace",
        id,
        "acc",
        "add-search-attribute",
        encodePromptArgs({ name: "CustomerId", type: "SEARCH_ATTRIBUTE_TYPE_INT" }),
      ),
    ).rejects.toThrow(/already exists/);
    await c.executeNoSqlCommand(
      "namespace",
      id,
      "acc",
      "add-search-attribute",
      encodePromptArgs({ name: "OrderTotal", type: "SEARCH_ATTRIBUTE_TYPE_DOUBLE" }),
    );
    const update = calls.find((x) => x.method === "POST");
    expect(update?.body).toMatchObject({
      spec: {
        searchAttributes: {
          CustomerId: "SEARCH_ATTRIBUTE_TYPE_KEYWORD",
          OrderTotal: "SEARCH_ATTRIBUTE_TYPE_DOUBLE",
        },
      },
    });
  });

  it("requires the namespace name to confirm a failover", async () => {
    const { c, calls } = client(nsRoute);
    const id = "acc:namespace:prod.a2dd6";
    await expect(
      c.executeNoSqlCommand(
        "namespace",
        id,
        "acc",
        "failover",
        encodePromptArgs({ region: "aws-us-west-2", confirm: "nope" }),
      ),
    ).rejects.toThrow(/confirm/);
    await expect(
      c.executeNoSqlCommand(
        "namespace",
        id,
        "acc",
        "failover",
        encodePromptArgs({ region: "aws-us-east-1", confirm: "prod" }),
      ),
    ).rejects.toThrow(/other than the active/);
    await c.executeNoSqlCommand(
      "namespace",
      id,
      "acc",
      "failover",
      encodePromptArgs({ region: "aws-us-west-2", confirm: "prod" }),
    );
    const call = calls.find((x) => x.url.pathname.endsWith("/failover-region"));
    expect(call?.body).toEqual({ region: "aws-us-west-2" });
  });

  it("refuses to delete a protected namespace", async () => {
    const { c } = client(nsRoute);
    await expect(c.deleteResource("namespace", "acc:namespace:prod.a2dd6", "acc")).rejects.toThrow(
      /Delete protection/,
    );
  });

  it("grants namespace access by updating the user spec", async () => {
    const user = {
      id: "u1",
      resourceVersion: "r1",
      spec: {
        email: "a@b.co",
        access: { accountAccess: { role: "ROLE_DEVELOPER" }, namespaceAccesses: {} },
      },
    };
    const { c, calls } = client((url, method) => {
      if (url.pathname === "/cloud/users/u1" && method === "GET") return { body: { user } };
      return { body: { asyncOperation: { id: "op", state: "STATE_FULFILLED" } } };
    });
    await c.executeNoSqlCommand(
      "user",
      "acc:user:u1",
      "acc",
      "set-namespace-access",
      encodePromptArgs({ namespace: "prod.a2dd6", permission: "write" }),
    );
    expect(calls.find((x) => x.method === "POST")?.body).toMatchObject({
      resourceVersion: "r1",
      spec: { access: { namespaceAccesses: { "prod.a2dd6": { permission: "PERMISSION_WRITE" } } } },
    });
  });

  it("round-trips Nexus descriptions as json/plain payloads", () => {
    const p = encodePayload("Payments API");
    expect(decodePayload(p.data)).toBe("Payments API");
    expect(atob(p.metadata["encoding"] ?? "")).toBe("json/plain");
  });
});

describe("status feed", () => {
  it("maps provider regions onto Temporal region ids", () => {
    expect(regionIdForComponent("us-east-1")).toBe("aws-us-east-1");
    expect(regionIdForComponent("ap-northeast-2")).toBe("aws-ap-northeast-2");
    expect(regionIdForComponent("us-central1")).toBe("gcp-us-central1");
    expect(regionIdForComponent("Metrics")).toBeNull();
  });

  it("parses an incident", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          {
            id: "i1",
            name: "Elevated latency",
            status: "investigating",
            impact: "minor",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            shortlink: "https://stspg.io/x",
            components: [{ name: "us-east-1" }],
          },
        ],
      }),
    );
    expect(incidents[0]?.regions).toEqual(["aws-us-east-1"]);
  });
});

describe("terraform export", () => {
  it("maps a namespace to temporalcloud_namespace", async () => {
    const { c } = client(nsRoute);
    const [ns] = await c.listResources("namespace", "acc");
    const result = temporalTerraformExport.mapResource(ns!);
    expect(result?.resource.type).toBe("temporalcloud_namespace");
    expect(result?.resource.importId).toBe("prod.a2dd6");
    expect(result?.resource.attributes).toMatchObject({
      name: { kind: "string", value: "prod" },
      retention_days: { kind: "number", value: 30 },
      api_key_auth: { kind: "bool", value: true },
    });
  });

  it("only claims types it maps", () => {
    const ids = new Set(plugin.resourceTypes.map((t) => t.id));
    for (const t of temporalTerraformExport.supportedResourceTypeIds) expect(ids.has(t)).toBe(true);
  });
});
