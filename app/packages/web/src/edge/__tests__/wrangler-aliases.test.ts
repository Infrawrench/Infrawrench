import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareWranglerAliases } from "@infrawrench/server-core/edge/wrangler-aliases.mjs";

describe("web edge Worker aliases", () => {
  it("stubs exactly the libraries server-core lists as gateway-only", () => {
    const config = fileURLToPath(new URL("../../../edge/wrangler.jsonc", import.meta.url));
    expect(compareWranglerAliases(config)).toEqual({ missing: [], extra: [] });
  });
});
