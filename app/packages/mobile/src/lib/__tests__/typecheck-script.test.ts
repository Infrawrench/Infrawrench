import { describe, expect, it } from "vitest";
import manifest from "../../../package.json";

describe("the typecheck script", () => {
  it("runs tsc-rs, which mobile depends on under its own name", () => {
    expect(manifest.scripts.typecheck).toMatch(/\btsc --noEmit\b/);
    expect(manifest.devDependencies["@tsc-rs/typescript"]).toBe("catalog:");
  });

  it("keeps `typescript` on TypeScript 6, whose JS API Expo's CLI requires", () => {
    expect(manifest.devDependencies.typescript).toMatch(/^npm:@typescript\/typescript6@/);
  });
});
