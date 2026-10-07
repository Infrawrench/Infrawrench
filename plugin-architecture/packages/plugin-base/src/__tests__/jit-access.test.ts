import { describe, expect, it } from "vitest";

import { jitGrantName } from "../jit-access.js";

describe("jitGrantName", () => {
  it("is deterministic and DNS-1123 safe", () => {
    const id = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
    expect(jitGrantName(id)).toBe("iw-jit-3f2504e04f8911d39a0c0305e82c3301");
    expect(jitGrantName(id)).toBe(jitGrantName(id.toLowerCase()));
    expect(jitGrantName(id)).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });

  it("refuses an id with nothing usable in it", () => {
    expect(() => jitGrantName("---")).toThrow();
  });
});
