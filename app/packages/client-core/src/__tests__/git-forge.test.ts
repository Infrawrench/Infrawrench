import { describe, expect, it } from "vitest";
import {
  GIT_FORGE_NAMESPACE_PLAN_REQUIRED,
  GIT_FORGE_UPGRADE,
  gitNamespaceClaimRefusal,
} from "../git-forge";

describe("gitNamespaceClaimRefusal", () => {
  it("lets an organisation on a paid plan claim its namespace", () => {
    expect(gitNamespaceClaimRefusal("paid")).toBeNull();
  });

  it("refuses one on the free plan, saying what it needs and where to get it", () => {
    const refusal = gitNamespaceClaimRefusal("free");
    expect(refusal).toBe(GIT_FORGE_NAMESPACE_PLAN_REQUIRED);
    expect(refusal).toContain("need a paid plan");
    expect(refusal).toContain(GIT_FORGE_UPGRADE);
  });
});
