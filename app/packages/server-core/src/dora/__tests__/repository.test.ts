import { describe, expect, it } from "vitest";
import { isOwnerSlashName, normalizeRepository } from "../repository";

describe("normalizeRepository", () => {
  it("reduces every spelling to owner/name", () => {
    expect(normalizeRepository("https://github.com/acme/web.git")).toBe("acme/web");
    expect(normalizeRepository("git@github.com:acme/web.git")).toBe("acme/web");
    expect(normalizeRepository("github.com/acme/web")).toBe("acme/web");
    expect(normalizeRepository("https://github.com/acme/web/tree/main")).toBe("acme/web");
    expect(normalizeRepository("acme/web")).toBe("acme/web");
    expect(normalizeRepository("https://gitlab.com/group/sub/proj")).toBe("group/sub/proj");
    expect(normalizeRepository("  ")).toBeNull();
    expect(normalizeRepository(null)).toBeNull();
  });

  it("recognises GitHub-shaped names", () => {
    expect(isOwnerSlashName("acme/web")).toBe(true);
    expect(isOwnerSlashName("group/sub/proj")).toBe(false);
  });
});
