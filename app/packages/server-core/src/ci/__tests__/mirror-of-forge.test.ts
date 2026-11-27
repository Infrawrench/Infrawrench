import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/client.js", () => ({ db: {} }));

const { githubMirrorAddresses } = await import("../git-repositories.js");

describe("githubMirrorAddresses", () => {
  it("names every way a mirror to the repository may be written, lowercased", () => {
    expect(githubMirrorAddresses("Infrawrench/Infrawrench")).toEqual([
      "https://github.com/infrawrench/infrawrench",
      "https://github.com/infrawrench/infrawrench/",
      "https://github.com/infrawrench/infrawrench.git",
      "https://github.com/infrawrench/infrawrench.git/",
    ]);
  });

  it("never matches another repository whose name starts the same", () => {
    expect(githubMirrorAddresses("acme/web")).not.toContain("https://github.com/acme/web-app.git");
  });
});
