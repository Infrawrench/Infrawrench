/**
 * Which page a key names among the pages of one head, and the key each page
 * is given back: the rules `resolveBranchKey` and `pageKeys` apply to what
 * they read (the database suites run both against Postgres).
 */
import { describe, expect, it } from "vitest";
import { canonicalOrdinal, pickPage } from "../branch-pages";

const page = (number: number, open: boolean) => ({ number, open });

describe("pickPage", () => {
  it("takes the open page for a bare name, even over a newer closed one", () => {
    const pages = [page(3, false), page(5, true), page(9, false)];
    expect(pickPage(pages, null)?.number).toBe(5);
  });

  it("takes the newest page when none is open", () => {
    expect(pickPage([page(3, false), page(9, false)], null)?.number).toBe(9);
    expect(pickPage([page(4, false)], null)?.number).toBe(4);
  });

  it("counts `~n` from the oldest page, whatever state", () => {
    const pages = [page(3, false), page(5, true), page(9, false)];
    expect(pickPage(pages, 1)?.number).toBe(3);
    expect(pickPage(pages, 2)?.number).toBe(5);
    expect(pickPage(pages, 3)?.number).toBe(9);
    expect(pickPage(pages, 4)).toBeUndefined();
  });

  it("finds nothing for a head with no page", () => {
    expect(pickPage([], null)).toBeUndefined();
    expect(pickPage([], 1)).toBeUndefined();
  });
});

describe("canonicalOrdinal", () => {
  it("leaves the page the bare name resolves to bare, and numbers the others", () => {
    const pages = [page(3, false), page(5, true), page(9, false)];
    expect(canonicalOrdinal(pages, 5)).toBeNull();
    expect(canonicalOrdinal(pages, 3)).toBe(1);
    expect(canonicalOrdinal(pages, 9)).toBe(3);
  });

  it("gives a reused name's newest page the bare name once nothing is open", () => {
    const pages = [page(3, false), page(9, false)];
    expect(canonicalOrdinal(pages, 9)).toBeNull();
    expect(canonicalOrdinal(pages, 3)).toBe(1);
  });

  it("agrees with pickPage: every canonical ordinal names its own page again", () => {
    const pages = [page(2, false), page(4, false), page(6, true), page(8, false)];
    for (const each of pages) {
      expect(pickPage(pages, canonicalOrdinal(pages, each.number))?.number).toBe(each.number);
    }
  });
});
