import { describe, expect, it } from "vitest";
import {
  agentGitWorkFromSearch,
  clearPendingAgentGitWork,
  setPendingAgentGitWork,
  validateAgentsSearch,
} from "../agent-git-work";

describe("the Agents route's search", () => {
  it("keeps a forge address and a pull request number", () => {
    expect(validateAgentsSearch({ git: "acme/infra", pull: 7 })).toEqual({
      git: "acme/infra",
      pull: 7,
    });
    // Typed by hand, the number arrives as text.
    expect(validateAgentsSearch({ git: "acme/infra.web", pull: "12" })).toEqual({
      git: "acme/infra.web",
      pull: 12,
    });
    expect(agentGitWorkFromSearch({ git: "acme/infra", pull: 7 })).toEqual({
      owner: "acme",
      repo: "infra",
      pull: 7,
    });
  });

  it("drops anything else", () => {
    for (const search of [
      { git: "acme", pull: 1 },
      { git: "acme/infra/extra", pull: 1 },
      { git: "acme/../infra", pull: 1 },
      { git: "acme/in fra", pull: 1 },
      { git: 3, pull: 1 },
    ]) {
      expect(validateAgentsSearch(search).git, JSON.stringify(search)).toBeUndefined();
    }
    for (const pull of [0, -1, 1.5, "1e3", "abc", 2 ** 31, null]) {
      expect(validateAgentsSearch({ git: "acme/infra", pull }).pull, String(pull)).toBeUndefined();
    }
    expect(validateAgentsSearch({ other: "x" })).toEqual({});
    expect(agentGitWorkFromSearch({ git: "acme/infra" })).toBeNull();
    expect(agentGitWorkFromSearch({ pull: 3 })).toBeNull();
  });

  it("hands work over and takes it back", () => {
    setPendingAgentGitWork("org-1", { owner: "acme", repo: "infra", pull: 7 });
    setPendingAgentGitWork("org-1", { owner: "acme", repo: "infra", pull: 7 });
    clearPendingAgentGitWork();
    clearPendingAgentGitWork();
  });
});
