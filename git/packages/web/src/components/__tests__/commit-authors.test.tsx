import { render } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { botUserForEmail } from "@infrawrench/git-contract";
import { routeTree } from "../../routeTree.gen";
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

  it("shows a bot account by its name and picture, linked to its page", async () => {
    // Links need a router around them.
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultComponent: () => null,
    });
    await router.load();
    const { container } = render(
      <RouterProvider
        router={router}
        defaultComponent={() => null}
        InnerWrap={() => (
          <CommitAuthors
            commit={{
              author,
              authorUser: null,
              coAuthors: [
                {
                  name: "Claude Fable 5.2",
                  email: "noreply@anthropic.com",
                  user: botUserForEmail("noreply@anthropic.com"),
                },
              ],
            }}
          />
        )}
      />,
    );
    // The account's name, not the one the commit wrote.
    expect(container.textContent).toContain("Astrid");
    expect(container.textContent).toContain("Claude");
    expect(container.textContent).not.toContain("Fable");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/claude");
    expect(link?.textContent).toBe("Claude");
    const pictures = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(pictures).toEqual(["/assets/bots/claude-icon.svg"]);
  });

  it("counts a bot among several by its name", () => {
    const { container } = render(
      <CommitAuthors
        commit={{
          author,
          authorUser: null,
          coAuthors: [
            {
              name: "x",
              email: "cursoragent@cursor.com",
              user: botUserForEmail("cursoragent@cursor.com"),
            },
            {
              name: "Claude Opus 5.5",
              email: "NoReply@anthropic.com",
              user: botUserForEmail("NoReply@anthropic.com"),
            },
          ],
        }}
      />,
    );
    const others = [...container.querySelectorAll("[title]")].find((node) =>
      node.textContent?.startsWith("2 others"),
    );
    expect(others?.getAttribute("title")).toBe("Astrid, Cursor, Claude");
    const pictures = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(pictures).toEqual(["/assets/bots/cursor-avatar.png", "/assets/bots/claude-icon.svg"]);
  });
});
