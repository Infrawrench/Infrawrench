import { describe, expect, it } from "vitest";
import {
  agentGitWorkFromSearch,
  clearPendingAgentGitWork,
  setPendingAgentGitWork,
  validateAgentsSearch,
} from "../agent-git-work";

describe("the Agents route's search", () => {
  it("keeps a forge address and a branch page's key", () => {
    expect(validateAgentsSearch({ git: "acme/infra", branch: "work/fix-login" })).toEqual({
      git: "acme/infra",
      branch: "work/fix-login",
    });
    expect(validateAgentsSearch({ git: "acme/infra.web", branch: "feature/a~2" })).toEqual({
      git: "acme/infra.web",
      branch: "feature/a~2",
    });
    expect(agentGitWorkFromSearch({ git: "acme/infra", branch: "work/fix-login" })).toEqual({
      owner: "acme",
      repo: "infra",
      branch: "work/fix-login",
    });
  });

  it("turns a branch name the router read as JSON back into its name", () => {
    expect(validateAgentsSearch({ git: "acme/infra", branch: 123 }).branch).toBe("123");
    expect(validateAgentsSearch({ git: "acme/infra", branch: true }).branch).toBe("true");
  });

  it("drops anything else", () => {
    for (const search of [
      { git: "acme", branch: "a" },
      { git: "acme/infra/extra", branch: "a" },
      { git: "acme/../infra", branch: "a" },
      { git: "acme/in fra", branch: "a" },
      { git: 3, branch: "a" },
    ]) {
      expect(validateAgentsSearch(search).git, JSON.stringify(search)).toBeUndefined();
    }
    for (const branch of ["", "a:b:c", "bob:main", "a~0", "x".repeat(513), null, {}, ["a"]]) {
      expect(
        validateAgentsSearch({ git: "acme/infra", branch }).branch,
        JSON.stringify(branch),
      ).toBeUndefined();
    }
    // The old number is no key the route keeps.
    expect(validateAgentsSearch({ git: "acme/infra", pull: 7 })).toEqual({ git: "acme/infra" });
    expect(validateAgentsSearch({ other: "x" })).toEqual({});
    expect(agentGitWorkFromSearch({ git: "acme/infra" })).toBeNull();
    expect(agentGitWorkFromSearch({ branch: "main" })).toBeNull();
  });

  it("hands work over and takes it back", () => {
    setPendingAgentGitWork("org-1", { owner: "acme", repo: "infra", branch: "work/a" });
    setPendingAgentGitWork("org-1", { owner: "acme", repo: "infra", branch: "work/a" });
    clearPendingAgentGitWork();
    clearPendingAgentGitWork();
  });
});
