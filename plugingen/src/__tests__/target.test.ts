import { describe, expect, it, vi } from "vitest";
import { main } from "../cli.js";
import { gitHubCli } from "../watch/github.js";
import { createTarget, targetName } from "../watch/target.js";

const TOKEN = "plugingen-test-credential-0123456789";

describe("targetName", () => {
  it("is GitHub unless told otherwise", () => {
    expect(targetName(undefined, {})).toBe("github");
    expect(targetName(undefined, { PLUGINGEN_TARGET: "" })).toBe("github");
    expect(targetName(undefined, { PLUGINGEN_TARGET: "github" })).toBe("github");
  });

  it("reads the variable, and lets the flag win over it", () => {
    expect(targetName(undefined, { PLUGINGEN_TARGET: "forge" })).toBe("forge");
    expect(targetName(undefined, { PLUGINGEN_TARGET: " forge\n" })).toBe("forge");
    expect(targetName("github", { PLUGINGEN_TARGET: "forge" })).toBe("github");
    expect(targetName("forge", {})).toBe("forge");
  });

  it("refuses anything else, naming where it came from", () => {
    expect(() => targetName(undefined, { PLUGINGEN_TARGET: "elsewhere" })).toThrow(
      /PLUGINGEN_TARGET must be github or forge, not elsewhere/,
    );
    expect(() => targetName("Forge", {})).toThrow(/--target must be github or forge/);
  });
});

describe("createTarget", () => {
  it("is the GitHub CLI and pull requests by default", () => {
    const target = createTarget("github", "/nowhere", {});
    expect(target.tracker).toBe(gitHubCli);
    expect(target.tracker.changeForm).toBeUndefined();
  });

  it("needs the forge's token, and says which variable without anything being run", () => {
    expect(() => createTarget("forge", "/nowhere", {})).toThrow(/PLUGINGEN_FORGE_TOKEN is not set/);
    expect(() => createTarget("forge", "/nowhere", { GH_TOKEN: "x" })).toThrow(
      /personal access token \(iwg_\) with the repo:write scope/,
    );
  });

  it("is branch pages on the forge once it has one", () => {
    const target = createTarget("forge", "/nowhere", { PLUGINGEN_FORGE_TOKEN: TOKEN });
    expect(target.name).toBe("forge");
    expect(target.tracker).not.toBe(gitHubCli);
    expect(target.tracker.changeForm).toBe("branch-page");
  });
});

describe("plugingen --target", () => {
  it("is bad usage for a target that does not exist", async () => {
    await expect(main(["watch", "--target", "elsewhere"])).resolves.toBe(64);
  });

  it("fails on a missing forge token before it fetches or changes anything", async () => {
    vi.stubEnv("PLUGINGEN_FORGE_TOKEN", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    const fetched = vi.spyOn(globalThis, "fetch");
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(main(["watch", "--apply", "--target", "forge"])).resolves.toBe(1);
      expect(said.mock.calls.join("\n")).toContain("PLUGINGEN_FORGE_TOKEN is not set");
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});
