import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasetenClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { installFetch, route, state } from "./helpers.js";

beforeEach(() => installFetch());
afterEach(() => vi.unstubAllGlobals());

describe("getLogs", () => {
  it("reads the newest lines with the chosen level and returns them oldest first", async () => {
    route("GET", "/v1/models/m-1/deployments/d-1/logs", {
      logs: [
        { timestamp: "1767225600000000000", message: "second", level: "ERROR", replica: "ab12c" },
        { timestamp: "1767225599000000000", message: "first", level: "ERROR" },
      ],
    });
    const c = new BasetenClient({ apiKey: "k" }, RESOURCE_TYPES);
    const res = await c.getLogs("deployment", "acc:deployment:m-1/d-1", "acc", {
      tailLines: 50,
      container: "Errors only",
    });
    const q = state.calls[0]!.query;
    expect(q.get("direction")).toBe("desc");
    expect(q.get("limit")).toBe("50");
    expect(q.get("min_level")).toBe("ERROR");
    expect(res.activeContainer).toBe("Errors only");
    expect(res.text).toBe(
      "2025-12-31T23:59:59.000Z ERROR first\n2026-01-01T00:00:00.000Z ERROR [ab12c] second\n",
    );
  });
});
