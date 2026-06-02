import { describe, it, expect, vi } from "vitest";
import { listAiSearchInstances, deleteAiSearchInstance } from "../clients/ai-search-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const INSTANCE = {
  id: "docs-rag",
  type: "r2",
  ai_search_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  embedding_model: "@cf/baai/bge-m3",
  namespace: "docs-rag-index",
  status: "ready",
  paused: false,
  last_activity: "2020-01-03T00:00:00Z",
  created_at: "2020-01-01T00:00:00Z",
  modified_at: "2020-01-02T00:00:00Z",
};

function searchApi(over: Record<string, unknown> = {}) {
  const instances = {
    list: vi.fn(() => asyncIter([INSTANCE])),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { aiSearch: { instances } }, ...over });
}

describe("ai-search-client", () => {
  it("listAiSearchInstances maps fields and stamps the output", async () => {
    const api = searchApi();
    const out = await listAiSearchInstances(api, "acct");
    expect(out[0]!.id).toBe("acct:ai-search:docs-rag");
    expect(out[0]!.externalId).toBe("docs-rag");
    expect(out[0]!.fields.source).toBe("r2");
    expect(out[0]!.fields.embeddingModel).toBe("@cf/baai/bge-m3");
    expect(out[0]!.fields.vectorizeName).toBe("docs-rag-index");
    expect(out[0]!.fields.paused).toBe("false");
    expect(out[0]!.resolvedOutputs.instanceId).toBe("docs-rag");
  });

  it("listAiSearchInstances surfaces a permission hint on a 403", async () => {
    const api = makeApi({
      cf: {
        aiSearch: {
          instances: {
            list: vi.fn(() => {
              throw { status: 403 };
            }),
          },
        },
      },
    });
    await expect(listAiSearchInstances(api, "acct")).rejects.toThrow(/AI Search:Read permission/);
  });

  it("deleteAiSearchInstance calls delete with the account id", async () => {
    const api = searchApi();
    await deleteAiSearchInstance(api, "docs-rag");
    expect(api.cf.aiSearch.instances.delete).toHaveBeenCalledWith("docs-rag", {
      account_id: "acct-cf",
    });
  });
});
