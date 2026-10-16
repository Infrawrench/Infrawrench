import { describe, expect, it } from "vitest";
import {
  EDITOR_SEARCH_KINDS,
  objectSearchResults,
  SEARCH_KIND_LABELS,
  SEARCH_OBJECT_KINDS,
  SEARCH_OBJECT_PLUGIN_ID,
  SEARCH_RESULT_KINDS,
  isSearchObjectKind,
  isSearchResultKind,
  searchQueryString,
  searchResultKind,
  starKey,
  starPath,
} from "../search";

describe("searchQueryString", () => {
  it("sends only q for the original contract", () => {
    expect(searchQueryString("  db  ")).toBe("q=db");
  });

  it("opts into kinds by name or all at once", () => {
    expect(searchQueryString("x", { kinds: "all" })).toBe("q=x&kinds=all");
    expect(searchQueryString("x", { kinds: ["cost_report", "slo"] })).toBe(
      "q=x&kinds=cost_report%2Cslo",
    );
    expect(searchQueryString("x", { kinds: [] })).toBe("q=x");
  });
});

describe("searchResultKind", () => {
  it("prefers the explicit kind", () => {
    expect(searchResultKind({ kind: "budget", pluginId: "aws", resourceTypeId: "x" })).toBe(
      "budget",
    );
  });

  it("infers kinds for hits from servers that predate the field", () => {
    expect(searchResultKind({ pluginId: "__workflows__", resourceTypeId: "__workflow__" })).toBe(
      "workflow",
    );
    expect(searchResultKind({ pluginId: SEARCH_OBJECT_PLUGIN_ID, resourceTypeId: "slo" })).toBe(
      "slo",
    );
    expect(searchResultKind({ pluginId: "aws", resourceTypeId: "ec2" })).toBe("resource");
  });
});

describe("kinds", () => {
  it("labels every kind", () => {
    for (const kind of SEARCH_RESULT_KINDS) {
      expect(SEARCH_KIND_LABELS[kind].singular).toBeTruthy();
      expect(SEARCH_KIND_LABELS[kind].plural).toBeTruthy();
    }
  });

  it("guards", () => {
    expect(isSearchResultKind("resource")).toBe(true);
    expect(isSearchObjectKind("resource")).toBe(false);
    expect(SEARCH_OBJECT_KINDS.every(isSearchObjectKind)).toBe(true);
    expect(isSearchResultKind("nope")).toBe(false);
    expect(isSearchResultKind(3)).toBe(false);
  });
});

describe("editor extension helpers", () => {
  it("ask for everything but services, which they list themselves", () => {
    expect(EDITOR_SEARCH_KINDS).toContain("resource");
    expect(EDITOR_SEARCH_KINDS).toContain("cost_report");
    expect(EDITOR_SEARCH_KINDS).not.toContain("service");
  });

  it("pick out saved-object hits", () => {
    const base = {
      pluginDisplayName: "",
      pluginLogoSvg: "",
      resourceTypeLabel: "",
      accountId: "",
      accountName: "",
      displayName: "x",
    };
    const hits = objectSearchResults([
      { ...base, id: "1", pluginId: "aws", resourceTypeId: "ec2" },
      { ...base, id: "2", pluginId: "__workflows__", resourceTypeId: "__workflow__" },
      { ...base, id: "3", pluginId: SEARCH_OBJECT_PLUGIN_ID, resourceTypeId: "slo", kind: "slo" },
    ]);
    expect(hits.map((h) => [h.id, h.kind])).toEqual([["3", "slo"]]);
  });
});

describe("stars", () => {
  it("keys and paths encode the id", () => {
    expect(starKey({ kind: "resource", id: "a/b" })).toBe("resource:a/b");
    expect(starPath({ kind: "resource", id: "a/b" })).toBe("/starred/resource/a%2Fb");
  });
});
