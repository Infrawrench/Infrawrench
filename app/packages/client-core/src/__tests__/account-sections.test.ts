import { describe, expect, it } from "vitest";
import {
  getVisibleAccountCategories,
  pickDefaultAccountSectionId,
  type SectionCategoryState,
  type SectionResource,
  type SectionTypeDef,
} from "../account-sections";

type Cat = SectionCategoryState<SectionTypeDef, SectionResource>;

function cat(partial: {
  id: string;
  supportsCreate?: boolean;
  loading?: boolean;
  displayName?: string;
  pluralDisplayName?: string;
  resources?: SectionResource[];
}): Cat {
  return {
    typeDef: {
      id: partial.id,
      displayName: partial.displayName ?? partial.id,
      pluralDisplayName: partial.pluralDisplayName ?? partial.id + "s",
      supportsCreate: partial.supportsCreate,
    },
    loading: partial.loading ?? false,
    error: null,
    resources: partial.resources ?? [],
  };
}

describe("getVisibleAccountCategories", () => {
  it("lists every populated type when not searching, parentage regardless", () => {
    const cats = [
      cat({ id: "top", resources: [{ id: "r", displayName: "R" }] }),
      cat({ id: "child", resources: [{ id: "r2", displayName: "R2" }] }),
    ];
    const visible = getVisibleAccountCategories(cats, "");
    expect(visible.map((c) => c.typeDef.id)).toEqual(["child", "top"]);
  });

  it("shows the same set of sections empty-query and searching", () => {
    // Regression: the empty-query path used to hide child types while the search
    // path did not, so typing a letter grew the tab bar instead of narrowing it.
    const cats = [
      cat({
        id: "domain",
        pluralDisplayName: "Domains",
        resources: [{ id: "1", displayName: "d" }],
      }),
      cat({
        id: "dns-record",
        pluralDisplayName: "DNS Records",
        resources: [{ id: "2", displayName: "d" }],
      }),
    ];
    const empty = getVisibleAccountCategories(cats, "").map((c) => c.typeDef.id);
    const searched = getVisibleAccountCategories(cats, "d").map((c) => c.typeDef.id);
    expect(empty).toEqual(["dns-record", "domain"]);
    expect(searched).toEqual(empty);
  });

  it("hides empty non-creatable categories", () => {
    const cats = [cat({ id: "empty" }), cat({ id: "creatable", supportsCreate: true })];
    expect(getVisibleAccountCategories(cats, "").map((c) => c.typeDef.id)).toEqual(["creatable"]);
  });

  it("keeps loading categories even when empty", () => {
    const cats = [cat({ id: "loading", loading: true })];
    expect(getVisibleAccountCategories(cats, "").map((c) => c.typeDef.id)).toEqual(["loading"]);
  });

  it("filters resources by query against name and fields", () => {
    const cats = [
      cat({
        id: "db",
        resources: [
          { id: "1", displayName: "prod-db", fields: { host: "prod.example.com" } },
          { id: "2", displayName: "staging-db", fields: { region: "eu" } },
        ],
      }),
    ];
    const visible = getVisibleAccountCategories(cats, "prod");
    expect(visible[0]!.resources.map((r) => r.id)).toEqual(["1"]);
  });

  it("reads fieldsJson when fields absent", () => {
    const cats = [
      cat({
        id: "db",
        resources: [{ id: "1", displayName: "x", fieldsJson: { engine: "postgres" } }],
      }),
    ];
    expect(getVisibleAccountCategories(cats, "postgres")[0]!.resources).toHaveLength(1);
  });

  it("keeps a section whose metadata matches even with no matching resources", () => {
    const cats = [
      // Query matches the section's type id ("buckets") but not the resource's
      // display name or the plural display name — so only the metadata branch
      // (which includes typeDef.id) keeps the section, with zero matching rows.
      cat({
        id: "buckets",
        displayName: "Storage",
        pluralDisplayName: "Storage",
        resources: [{ id: "1", displayName: "nope" }],
      }),
    ];
    const visible = getVisibleAccountCategories(cats, "buckets");
    expect(visible).toHaveLength(1);
    expect(visible[0]!.resources).toHaveLength(0);
  });

  it("drops a section with no matching resources and no metadata match", () => {
    const cats = [cat({ id: "db", resources: [{ id: "1", displayName: "alpha" }] })];
    expect(getVisibleAccountCategories(cats, "zzz")).toHaveLength(0);
  });

  it("sorts results by pluralDisplayName", () => {
    const cats = [
      cat({ id: "b", pluralDisplayName: "Zebras", resources: [{ id: "1", displayName: "x" }] }),
      cat({ id: "a", pluralDisplayName: "Apples", resources: [{ id: "2", displayName: "y" }] }),
    ];
    expect(getVisibleAccountCategories(cats, "").map((c) => c.typeDef.pluralDisplayName)).toEqual([
      "Apples",
      "Zebras",
    ]);
  });
});

describe("pickDefaultAccountSectionId", () => {
  it("returns null for no categories", () => {
    expect(pickDefaultAccountSectionId([])).toBeNull();
  });
  it("returns the first category with resources", () => {
    const cats = [
      cat({ id: "empty" }),
      cat({ id: "full", resources: [{ id: "1", displayName: "x" }] }),
    ];
    expect(pickDefaultAccountSectionId(cats)).toBe("full");
  });
  it("falls back to the first category when none have resources", () => {
    const cats = [cat({ id: "first" }), cat({ id: "second" })];
    expect(pickDefaultAccountSectionId(cats)).toBe("first");
  });
});
