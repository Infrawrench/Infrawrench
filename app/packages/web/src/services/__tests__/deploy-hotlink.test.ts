import { describe, expect, it } from "vitest";

import { parseRepoPath } from "../../routes/deploy.$";

/**
 * The hotlink is meant to survive being pasted from an address bar, a git
 * remote, or a chat client that helpfully appended punctuation — so the shapes
 * it accepts are the point rather than an implementation detail.
 */
describe("parseRepoPath", () => {
  it("accepts the canonical hotlink form", () => {
    expect(parseRepoPath("github.com/astrid/my-app")).toBe("astrid/my-app");
  });

  it("accepts a bare owner/name", () => {
    expect(parseRepoPath("astrid/my-app")).toBe("astrid/my-app");
  });

  it("tolerates a pasted URL, a .git suffix and a trailing slash", () => {
    expect(parseRepoPath("https://github.com/astrid/my-app")).toBe("astrid/my-app");
    expect(parseRepoPath("https://www.github.com/astrid/my-app.git")).toBe("astrid/my-app");
    expect(parseRepoPath("github.com/astrid/my-app/")).toBe("astrid/my-app");
  });

  it("rejects anything that is not exactly owner/name", () => {
    expect(parseRepoPath("astrid")).toBeNull();
    expect(parseRepoPath("github.com/astrid")).toBeNull();
    // A deep link into a file is not a repository, and silently truncating it
    // would deploy something the user did not ask for.
    expect(parseRepoPath("github.com/astrid/my-app/tree/main")).toBeNull();
    expect(parseRepoPath("")).toBeNull();
  });
});
