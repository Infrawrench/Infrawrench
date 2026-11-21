import { describe, it, expect, vi } from "vitest";

/**
 * Chat sends every registry tool, but only the `alwaysLoaded` ones go into the
 * model's context up front; the rest wait behind tool search. These guard the
 * bill: the whole registry as context made a single "hello" cost $2.25 in cache
 * writes, so the up-front set has to stay small as tools are added.
 */

process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] ??= "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] ??= "test_workos_client_id";

vi.mock("@infrawrench/server-core/products/settings", () => ({
  disabledProducts: vi.fn(async () => []),
}));

const { getToolRegistry } = await import("../registry");
const { toolInputJsonSchema } = await import("../json-schema");

function schemaChars(t: Awaited<ReturnType<typeof getToolRegistry>>[number]): number {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    input_schema: toolInputJsonSchema(t.inputSchema),
  }).length;
}

describe("tools chat loads up front", () => {
  it("stay a handful", async () => {
    const loaded = (await getToolRegistry()).filter((t) => t.alwaysLoaded);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.length).toBeLessThanOrEqual(15);
  });

  it("stay small: about 15K tokens of schema at most", async () => {
    const loaded = (await getToolRegistry()).filter((t) => t.alwaysLoaded);
    const chars = loaded.reduce((sum, t) => sum + schemaChars(t), 0);
    expect(chars).toBeLessThan(40_000);
  });

  it("leave the deferred set under the API's 10,000-tool cap", async () => {
    const deferred = (await getToolRegistry()).filter((t) => !t.alwaysLoaded);
    expect(deferred.length).toBeLessThan(10_000);
  });
});
