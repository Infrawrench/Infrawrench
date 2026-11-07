import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanClient } from "../client.js";
import { doGetCreateConfig } from "../create-handlers.js";
import { ModelApiKeyResourceType } from "../resources/model-api-key.js";
import { fakeApi } from "./fake-api.js";

const ACC = "acc1";
const BASE = "https://api.digitalocean.com/v2";

function route(answer: (path: string) => object | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.startsWith(BASE)) throw new Error(`Unexpected host: ${url}`);
      const body = answer(url.slice(BASE.length).split("?")[0]!);
      return body instanceof Response ? body : new Response(JSON.stringify(body));
    }),
  );
}

const client = () => hostClient(new DigitalOceanClient({ apiToken: "tok" }));

afterEach(() => vi.unstubAllGlobals());

describe("Gradient AI reads what the API returns (#414)", () => {
  it("takes an agent's knowledge bases from its own read, since list rows have none", async () => {
    route((path) => {
      if (path === "/gen-ai/agents") return { agents: [{ uuid: "a-1", name: "A" }] };
      if (path === "/gen-ai/agents/a-1") {
        return { agent: { uuid: "a-1", knowledge_bases: [{ uuid: "kb-1" }, { uuid: "kb-2" }] } };
      }
      throw new Error(`Unexpected: ${path}`);
    });
    const [agent] = await client().listResources("gen-ai-agent", ACC);
    expect(agent!.fields["knowledgeBaseCount"]).toBe(2);
    expect(agent!.fields["knowledgeBaseUuids"]).toBe("kb-1, kb-2");
  });

  it("keeps the agent when its own read fails", async () => {
    route((path) =>
      path === "/gen-ai/agents"
        ? { agents: [{ uuid: "a-1", name: "A" }] }
        : new Response("{}", { status: 500 }),
    );
    const agents = await client().listResources("gen-ai-agent", ACC);
    expect(agents.map((a) => a.externalId)).toEqual(["a-1"]);
    expect(agents[0]!.fields["knowledgeBaseCount"]).toBe(0);
  });

  it("counts a knowledge base's data sources from their own route", async () => {
    route((path) => {
      if (path === "/gen-ai/knowledge_bases") {
        return { knowledge_bases: [{ uuid: "kb-1" }, { uuid: "kb-2" }] };
      }
      return path.includes("kb-1")
        ? { knowledge_base_data_sources: [{ uuid: "d" }], meta: { total: 7 } }
        : {};
    });
    const rows = await client().listResources("gen-ai-knowledge-base", ACC);
    expect(rows.map((r) => r.fields["dataSourceCount"])).toEqual([7, 0]);
  });

  it("names a function route from `name`", async () => {
    route((path) => {
      if (path === "/gen-ai/agents/a-1") {
        return { agent: { functions: [{ uuid: "f-1", name: "lookup", faas_name: "x" }] } };
      }
      return {};
    });
    const enriched = await client().enrichDetail({
      id: `${ACC}:gen-ai-agent:a-1`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
      accountId: ACC,
      displayName: "A",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      externalId: "a-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(JSON.parse(enriched.resolvedOutputs["__functions__"]!)[0].function_name).toBe("lookup");
  });

  it("shows a model's provider from the enum the document describes", async () => {
    const fetch = vi.fn(async (path: string) =>
      path.startsWith("/gen-ai/models?")
        ? {
            models: [
              { uuid: "m-1", name: "Claude", provider: "MODEL_PROVIDER_ANTHROPIC" },
              { uuid: "m-2", name: "New", provider: "MODEL_PROVIDER_SOMEONE" },
              { uuid: "m-3", name: "Plain" },
            ],
          }
        : {},
    );
    const ctx = { api: fakeApi(fetch), credentials: {} };
    const config = await doGetCreateConfig(ctx, "gen-ai-agent");
    const model = config.fields.find((f) => f.key === "modelUuid");
    expect(model && "options" in model ? model.options?.map((o) => o.label) : []).toEqual([
      "Claude (Anthropic)",
      "New (SOMEONE)",
      "Plain",
    ]);
  });

  it("shows when a model key was created, and claims no last use", async () => {
    route(() => ({
      api_key_infos: [{ uuid: "k-1", name: "key", created_at: "2026-02-01T00:00:00Z" }],
    }));
    const [key] = await client().listResources("model-api-key", ACC);
    expect(key!.fields["createdAt"]).toBe("2026-02-01T00:00:00Z");
    expect(key!.fields).not.toHaveProperty("lastUsedAt");
    expect(ModelApiKeyResourceType.principalRole?.lastUsedKey).toBeUndefined();
    expect(ModelApiKeyResourceType.fields.map((f) => f.key)).not.toContain("lastUsedAt");
  });
});
