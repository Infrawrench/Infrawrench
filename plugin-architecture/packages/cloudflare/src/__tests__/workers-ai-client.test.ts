import { describe, it, expect, vi } from "vitest";
import { listWorkersAiModels } from "../clients/workers-ai-client.js";
import { makeApi } from "./_helpers.js";

describe("workers-ai-client", () => {
  it("listWorkersAiModels maps the catalog", async () => {
    const fetch = vi.fn(async () => [
      { name: "@cf/meta/llama-3", task: { name: "Text Generation" }, description: "LLM" },
    ]);
    const api = makeApi({ fetch });
    const out = await listWorkersAiModels(api, "acct");
    expect(fetch).toHaveBeenCalledWith(
      "/accounts/acct-cf/ai/models/search?per_page=100&task=Text%20Generation",
    );
    expect(out[0].id).toBe("acct:workers-ai-model:@cf/meta/llama-3");
    expect(out[0].externalId).toBe("@cf/meta/llama-3");
    expect(out[0].fields.task).toBe("Text Generation");
    expect(out[0].fields.description).toBe("LLM");
  });

  it("listWorkersAiModels defaults task and falls back to id", async () => {
    const api = makeApi({ fetch: vi.fn(async () => [{ id: "@cf/x" }]) });
    const out = await listWorkersAiModels(api, "acct");
    expect(out[0].fields.name).toBe("@cf/x");
    expect(out[0].fields.task).toBe("Text Generation");
  });

  it("listWorkersAiModels handles a null response", async () => {
    const api = makeApi({ fetch: vi.fn(async () => null) });
    const out = await listWorkersAiModels(api, "acct");
    expect(out).toEqual([]);
  });
});
