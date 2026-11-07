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
      "/accounts/acct-cf/ai/models/search?per_page=100&task=Text%20Generation&page=1",
    );
    expect(out[0]!.id).toBe("acct:workers-ai-model:@cf/meta/llama-3");
    expect(out[0]!.externalId).toBe("@cf/meta/llama-3");
    expect(out[0]!.fields.task).toBe("Text Generation");
    expect(out[0]!.fields.description).toBe("LLM");
  });

  it("listWorkersAiModels defaults task and falls back to id", async () => {
    const api = makeApi({ fetch: vi.fn(async () => [{ id: "@cf/x" }]) });
    const out = await listWorkersAiModels(api, "acct");
    expect(out[0]!.fields.name).toBe("@cf/x");
    expect(out[0]!.fields.task).toBe("Text Generation");
  });

  it("listWorkersAiModels reads past a full page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `@cf/m${i}` }));
    const fetch = vi.fn(async (path: string) =>
      path.endsWith("&page=1") ? full : [{ name: "@cf/last" }],
    );
    const out = await listWorkersAiModels(makeApi({ fetch }), "acct");
    expect(out).toHaveLength(101);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("listWorkersAiModels throws at its cap rather than returning part", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `@cf/m${i}` }));
    const fetch = vi.fn(async () => full);
    await expect(listWorkersAiModels(makeApi({ fetch }), "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(fetch).toHaveBeenCalledTimes(100);
  });

  it("listWorkersAiModels refuses an answer that is not a list", async () => {
    const api = makeApi({ fetch: vi.fn(async () => ({ models: [] })) });
    await expect(listWorkersAiModels(api, "acct")).rejects.toThrow("is not a list");
  });

  it("listWorkersAiModels handles a null response", async () => {
    const api = makeApi({ fetch: vi.fn(async () => null) });
    const out = await listWorkersAiModels(api, "acct");
    expect(out).toEqual([]);
  });
});
