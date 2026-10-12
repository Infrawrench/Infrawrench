import { describe, expect, it } from "vitest";
import { TtlCache } from "../cache";
import { escapeMarkdown, commandLink } from "../markdown";
import { githubRepoFromRemote } from "../org-input";

describe("githubRepoFromRemote", () => {
  it("reads https and ssh remotes", () => {
    expect(githubRepoFromRemote("git@github.com:Acme/infra.git")).toBe("Acme/infra");
    expect(githubRepoFromRemote("https://github.com/acme/infra\n")).toBe("acme/infra");
    expect(githubRepoFromRemote("https://gitlab.com/acme/infra.git")).toBeNull();
  });
});

describe("markdown", () => {
  it("escapes provider-supplied names and encodes command args", () => {
    expect(escapeMarkdown("a_b*[c]")).toBe("a\\_b\\*\\[c\\]");
    expect(commandLink("Open", "x.y", [{ id: "a/b" }])).toBe(
      `[Open](command:x.y?${encodeURIComponent('[{"id":"a/b"}]')})`,
    );
  });
});

describe("TtlCache", () => {
  it("shares in-flight loads, expires, and forgets failures", async () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, () => now);
    let loads = 0;
    const load = async () => ++loads;
    await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect(loads).toBe(1);
    now = 2000;
    expect(await cache.get("k", load)).toBe(2);
    await expect(cache.get("bad", () => Promise.reject(new Error("x")))).rejects.toThrow();
    await Promise.resolve();
    expect(await cache.get("bad", async () => 7)).toBe(7);
  });
});
