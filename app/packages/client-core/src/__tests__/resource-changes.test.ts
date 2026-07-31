import { describe, expect, it } from "vitest";
import {
  changeFeedSearchParams,
  formatChangeValue,
  summarizeChange,
  type ResourceChangeEntry,
} from "../resource-changes";

describe("changeFeedSearchParams", () => {
  it("is empty for a bare request — page 1 of the whole org", () => {
    expect(changeFeedSearchParams({})).toBe("");
  });

  it("emits one parameter per filter the route reads", () => {
    const query = changeFeedSearchParams({
      page: 2,
      pageSize: 25,
      kind: "deleted",
      accountId: "acct-1",
      resourceId: "do:acct-1:droplet/9",
      from: "2026-07-30T00:00:00.000Z",
      to: "2026-07-31T00:00:00.000Z",
    });
    const params = new URLSearchParams(query);
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("25");
    expect(params.get("kind")).toBe("deleted");
    expect(params.get("accountId")).toBe("acct-1");
    expect(params.get("resourceId")).toBe("do:acct-1:droplet/9");
    expect(params.get("from")).toBe("2026-07-30T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-07-31T00:00:00.000Z");
  });

  it("drops empty filters rather than sending them", () => {
    expect(changeFeedSearchParams({ kind: undefined, accountId: "", resourceId: undefined })).toBe(
      "",
    );
  });

  it("drops unparseable dates — the server would compare against an Invalid Date", () => {
    expect(changeFeedSearchParams({ from: "yesterday" })).toBe("");
    expect(changeFeedSearchParams({ to: "" })).toBe("");
  });

  it("drops non-finite paging numbers", () => {
    expect(changeFeedSearchParams({ page: Number.NaN, pageSize: Number.POSITIVE_INFINITY })).toBe(
      "",
    );
  });
});

describe("summarizeChange", () => {
  const entry = (
    changeKind: ResourceChangeEntry["changeKind"],
    fields: string[],
  ): Pick<ResourceChangeEntry, "changeKind" | "diff"> => ({
    changeKind,
    diff: fields.map((field) => ({ field, from: 1, to: 2 })),
  });

  it("names the kind for created and deleted", () => {
    expect(summarizeChange(entry("created", []))).toBe("Appeared");
    expect(summarizeChange(entry("deleted", []))).toBe("Disappeared");
  });

  it("lists changed fields and caps the list at three", () => {
    expect(summarizeChange(entry("updated", ["a", "b"]))).toBe("a, b");
    expect(summarizeChange(entry("updated", ["a", "b", "c", "d", "e"]))).toBe("a, b, c and 2 more");
  });
});

describe("formatChangeValue", () => {
  it("renders absent values as an em dash", () => {
    expect(formatChangeValue(null)).toBe("—");
    expect(formatChangeValue(undefined)).toBe("—");
  });

  it("JSON-stringifies objects", () => {
    expect(formatChangeValue({ a: 1 })).toBe('{"a":1}');
  });
});
