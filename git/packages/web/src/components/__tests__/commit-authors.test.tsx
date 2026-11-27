import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommitAuthors } from "../people";

const author = {
  name: "Astrid",
  email: "astrid@example.com",
  when: "2026-11-26T00:00:00Z",
  timezoneOffset: 0,
};
const person = (name: string) => ({ name, email: `${name.toLowerCase()}@example.com`, user: null });

describe("CommitAuthors", () => {
  it("shows the author alone when there are no co-authors", () => {
    const { container } = render(
      <CommitAuthors commit={{ author, authorUser: null, coAuthors: [] }} />,
    );
    expect(container.textContent).toContain("Astrid");
    expect(container.textContent).not.toContain("and");
  });

  it("names one co-author beside the author", () => {
    const { container } = render(
      <CommitAuthors commit={{ author, authorUser: null, coAuthors: [person("Claude")] }} />,
    );
    expect(container.textContent).toContain("Astrid");
    expect(container.textContent).toContain("and");
    expect(container.textContent).toContain("Claude");
  });

  it("counts several and lists them all for a screen reader and on hover", () => {
    const { container } = render(
      <CommitAuthors
        commit={{
          author,
          authorUser: null,
          coAuthors: [person("Claude"), person("Grace"), person("Ada")],
        }}
      />,
    );
    expect(container.textContent).toContain("3 others");
    const others = [...container.querySelectorAll("[title]")].find((node) =>
      node.textContent?.startsWith("3 others"),
    );
    expect(others?.getAttribute("title")).toBe("Astrid, Claude, Grace, Ada");
    expect(others?.textContent).toContain("Astrid, Claude, Grace, Ada");
    // At most three faces.
    expect(container.querySelectorAll("[aria-hidden='true'] > span").length).toBe(3);
  });
});
