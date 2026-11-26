// git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
import { describe, expect, it } from "vitest";
import { gitFeatureHides } from "../git-feature-flag";

describe("gitFeatureHides", () => {
  it("hides the git: permissions only when the organisation's Git is off", () => {
    expect(gitFeatureHides("git:read", { gitEnabled: false })).toBe(true);
    expect(gitFeatureHides("git:admin", { gitEnabled: false })).toBe(true);
    expect(gitFeatureHides("resources:read", { gitEnabled: false })).toBe(false);
    expect(gitFeatureHides("git:read", { gitEnabled: true })).toBe(false);
  });

  it("treats an answer without the field as on, as a server without the flag sends", () => {
    expect(gitFeatureHides("git:read", {})).toBe(false);
    expect(gitFeatureHides("git:read", { gitEnabled: undefined })).toBe(false);
    expect(gitFeatureHides("git:read", null)).toBe(false);
  });
});
