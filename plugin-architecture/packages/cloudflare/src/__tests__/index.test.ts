import { describe, it, expect } from "vitest";
import * as pkg from "../index.js";

describe("package entrypoint", () => {
  it("re-exports the plugin and client", () => {
    expect(pkg.plugin).toBeTruthy();
    expect(pkg.CloudflareClient).toBeTypeOf("function");
    expect(pkg.ZoneResourceType).toBeTruthy();
  });
});
