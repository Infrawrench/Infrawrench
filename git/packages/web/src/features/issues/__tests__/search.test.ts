import { describe, expect, it } from "vitest";
import {
  EMPTY_SEARCH,
  editSearch,
  formatSearch,
  isFiltered,
  parseSearch,
  toListQuery,
  tokenize,
} from "../search";

describe("tokenize", () => {
  it("keeps a quoted value whole", () => {
    expect(tokenize('is:open label:"good first issue"  flow logs')).toEqual([
      "is:open",
      'label:"good first issue"',
      "flow",
      "logs",
    ]);
  });
});

describe("parseSearch", () => {
  it("reads nothing as everything", () => {
    expect(parseSearch("")).toEqual(EMPTY_SEARCH);
  });

  it("reads the qualifiers and leaves the rest as words", () => {
    expect(
      parseSearch(
        'is:open author:mara assignee:@me label:bug label:"good first issue" milestone:"Cost review Q4" NAT gateway',
      ),
    ).toEqual({
      ...EMPTY_SEARCH,
      state: "open",
      author: "mara",
      assignee: "@me",
      labels: ["bug", "good first issue"],
      milestone: "Cost review Q4",
      words: "NAT gateway",
    });
  });

  it("reads state: as is:, and the last state wins", () => {
    expect(parseSearch("state:closed").state).toBe("closed");
    expect(parseSearch("is:open is:merged").state).toBe("merged");
    expect(parseSearch("is:all").state).toBe("all");
  });

  it("reads no: for an absent assignee or milestone", () => {
    const search = parseSearch("no:assignee no:milestone");
    expect(search.assignee).toBe("none");
    expect(search.milestone).toBe("none");
  });

  it("reads drafts, reviewers and branches", () => {
    expect(parseSearch("is:draft").draft).toBe(true);
    expect(parseSearch("draft:false").draft).toBe(false);
    expect(parseSearch("reviewed-by:priya base:main head:feature/x")).toMatchObject({
      reviewer: "priya",
      base: "main",
      head: "feature/x",
    });
  });

  it("reads a sort with its direction, descending when none is given", () => {
    expect(parseSearch("sort:updated")).toMatchObject({ sort: "updated", direction: "desc" });
    expect(parseSearch("sort:created-asc")).toMatchObject({ sort: "created", direction: "asc" });
  });

  it("keeps what it does not know as words", () => {
    expect(parseSearch("is:pinned sort:size foo:bar no:label http://x").words).toBe(
      "is:pinned sort:size foo:bar no:label http://x",
    );
    expect(parseSearch("label:").words).toBe("label:");
  });

  it("does not repeat a label", () => {
    expect(parseSearch("label:bug label:bug").labels).toEqual(["bug"]);
  });
});

describe("formatSearch", () => {
  it("writes qualifiers in one order and quotes values with spaces", () => {
    expect(
      formatSearch({
        ...EMPTY_SEARCH,
        state: "open",
        labels: ["good first issue", "bug"],
        author: "mara",
        sort: "comments",
        words: "flow logs",
      }),
    ).toBe('is:open author:mara label:"good first issue" label:bug sort:comments-desc flow logs');
  });

  it("round-trips", () => {
    for (const text of [
      "is:open",
      "is:closed no:assignee no:milestone",
      'is:merged is:draft author:jonas assignee:mara label:cost milestone:"Staging parity" reviewed-by:priya base:main head:fix/x sort:updated-asc backup',
      "draft:false words only",
      "",
    ]) {
      expect(formatSearch(parseSearch(text))).toBe(text);
    }
  });
});

describe("editSearch", () => {
  it("changes one thing and keeps the rest", () => {
    expect(editSearch("is:open label:bug nat", { state: "closed" })).toBe(
      "is:closed label:bug nat",
    );
    expect(editSearch("is:open label:bug", { labels: [] })).toBe("is:open");
    expect(editSearch("is:open", { assignee: "none" })).toBe("is:open no:assignee");
  });
});

describe("isFiltered", () => {
  it("is false for a state alone", () => {
    expect(isFiltered(parseSearch("is:open"))).toBe(false);
    expect(isFiltered(parseSearch("is:closed"))).toBe(false);
    expect(isFiltered(parseSearch("is:open label:bug"))).toBe(true);
    expect(isFiltered(parseSearch("nat"))).toBe(true);
  });
});

describe("toListQuery", () => {
  const milestones = [
    { number: 1, title: "Cost review Q4" },
    { number: 3, title: "Staging parity" },
  ];

  it("sends only what narrows the list", () => {
    expect(toListQuery(parseSearch("is:open"), milestones)).toEqual({ state: "open" });
  });

  it("names a milestone by its number, whatever the case of its title", () => {
    expect(toListQuery(parseSearch('milestone:"cost review q4"'), milestones).milestone).toBe("1");
    expect(toListQuery(parseSearch("no:milestone"), milestones).milestone).toBe("none");
  });

  it("matches nothing for a milestone that does not exist", () => {
    expect(toListQuery(parseSearch("milestone:Nope"), milestones).milestone).toBe("0");
  });

  it("joins labels and passes the rest through", () => {
    expect(
      toListQuery(
        parseSearch("is:closed label:bug label:cost assignee:@me sort:updated-asc is:draft nat"),
        milestones,
      ),
    ).toEqual({
      state: "closed",
      label: "bug,cost",
      assignee: "@me",
      sort: "updated",
      direction: "asc",
      draft: "true",
      q: "nat",
    });
  });
});
