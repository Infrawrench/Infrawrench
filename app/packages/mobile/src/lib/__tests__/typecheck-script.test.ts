import { describe, expect, it } from "vitest";
import manifest from "../../../package.json";

describe("the typecheck script", () => {
  it("runs TypeScript 6, because a plain `tsc` here finds the root's tsc-rs", () => {
    expect(manifest.scripts.typecheck).toMatch(/\btsc6 --noEmit\b/);
  });
});
