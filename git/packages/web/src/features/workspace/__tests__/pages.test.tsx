/**
 * The sidebar shell and the pages of someone's work against the dev mock,
 * through the real router: home, Changes and its filters, Mentions, a
 * repository inside the shell, the mode switch in both account menus, and
 * who keeps the top-nav shell.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, api, setTransport, type Transport } from "../../../api/client";
import { queryClient } from "../../../api/queries";
import { setScenario } from "../../../mock/db";
import { routeTree } from "../../../routeTree.gen";

/** The dev mock's handlers as a transport, without its artificial delay. */
function mockTransport(): Transport {
  const handlers = import.meta.glob<{ default: Record<string, Record<string, unknown>> }>(
    "../../../mock/handlers/*.ts",
    { eager: true },
  );
  const table = new Map<string, (request: unknown) => unknown>();
  for (const [file, module] of Object.entries(handlers)) {
    for (const [group, endpoints] of Object.entries(module.default)) {
      for (const [endpoint, handler] of Object.entries(endpoints ?? {})) {
        const key = `${group}.${endpoint}`;
        // The mock refuses to start with two answers for one endpoint: so does this.
        if (table.has(key)) throw new Error(`Two mock handlers for ${key} (second in ${file})`);
        table.set(key, handler as (request: unknown) => unknown);
      }
    }
  }
  return async ({ group, endpoint, request }) => {
    const handler = table.get(`${group}.${endpoint}`);
    if (handler === undefined) throw new ApiError(501, `No mock handler for ${group}.${endpoint}`);
    const answer = await handler(request);
    return answer === undefined ? undefined : structuredClone(answer);
  };
}

const mock = mockTransport();
const wait = { timeout: 10_000 };
vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
  window.scrollTo = () => {};
  setTransport(mock);
});

function open(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(async () => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  setScenario("signed-in");
  await api.review.setMode({ payload: { mode: "agent" } });
});

const sidebar = () => within(screen.getByRole("navigation", { name: "Workspace" }));

describe("home in agent mode", () => {
  it("counts the team's branches and lists the reader's, the team's and the suggested", async () => {
    open("/");
    expect(
      await screen.findByRole("heading", { name: "Your team has 15 active branches" }, wait),
    ).toBeTruthy();
    expect(
      screen.getByText(/^In the last week, your team has pushed changes to .+, and .+\.$/),
    ).toBeTruthy();

    const yours = within(screen.getByRole("list", { name: "Your changes" }));
    expect(yours.getAllByRole("listitem")).toHaveLength(4);
    const working = yours.getByRole("link", {
      name: "Skip upstreams that fail their health check",
    });
    expect(working.getAttribute("href")).toBe("/acme/edge-router/pulls/4");
    expect(within(working.closest("li")!).getByRole("img", { name: "Agent working" })).toBeTruthy();

    // Five of the eleven, and every one somebody else's.
    const team = within(screen.getByRole("list", { name: "Team changes" }));
    expect(team.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("region", { name: "Team changes" }).textContent).toContain("11");

    const suggested = within(screen.getByRole("list", { name: "Suggested for your review" }));
    const first = suggested.getAllByRole("listitem")[0]!;
    expect(first.textContent).toContain("Deduplicate usage events by idempotency key");
    expect(first.textContent).toContain("Assigned to you");
    expect(first.textContent).toMatch(/\dm review/);
    // One the reader reviewed opens on what is new since.
    expect(
      suggested
        .getByRole("link", { name: "Peer with the shared services VPC" })
        .getAttribute("href"),
    ).toBe("/acme/infra/pulls/12?v=3&diff=since");
    // A branch with no description is named by its commit.
    expect(
      within(suggested.getByRole("link", { name: "fix weight rounding" }).closest("li")!).getByText(
        /^[0-9a-f]{7}$/,
      ),
    ).toBeTruthy();

    const activity = within(screen.getByRole("region", { name: "Workspace activity" }));
    expect(activity.getAllByRole("listitem")[0]!.textContent).toContain(
      "Jonas Weber pushed v3 to Peer with the shared services VPC",
    );
    expect(activity.getByText(/found 2 must fix on/)).toBeTruthy();
    expect(screen.getByText("2 agents working")).toBeTruthy();
  });

  it("follows the workspace picked in the sidebar, down to one with nothing open", async () => {
    open("/");
    await screen.findByRole("heading", { name: /15 active branches/ }, wait);
    fireEvent.click(screen.getByRole("button", { name: "Workspace: Acme" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Tidewater" }));
    expect(
      await screen.findByRole("heading", { name: "Your team has 2 active branches" }, wait),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Workspace: Tidewater" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mara Lindqvist" }));
    expect(await screen.findByRole("heading", { name: "No active branches" }, wait)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start work" }).getAttribute("href")).toMatch(
      /^\/mara\/[^/]+\/pulls\/start$/,
    );
  });

  it("looks as far back as the range says", async () => {
    open("/");
    await screen.findByRole("heading", { name: /15 active branches/ }, wait);
    fireEvent.click(screen.getByRole("button", { name: "Range: Last 7 days" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Last 24 hours" }));
    expect(await screen.findByText(/^In the last day, /, {}, wait)).toBeTruthy();
    const activity = within(screen.getByRole("region", { name: "Workspace activity" }));
    await waitFor(() => expect(activity.queryByText(/merged/)).toBeNull(), wait);
  });
});

describe("the sidebar", () => {
  it("lists the reader's work and each namespace's repositories, the others folded", async () => {
    open("/");
    await screen.findByRole("heading", { name: /active branches/ }, wait);
    const nav = sidebar();
    expect(nav.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    for (const [name, href] of [
      ["Changes", "/changes"],
      ["Reviews", "/reviews"],
      ["Mentions", "/mentions"],
    ]) {
      expect(nav.getByRole("link", { name: name! }).getAttribute("href")).toBe(href);
    }
    expect(nav.getByRole("link", { name: "infra" }).getAttribute("href")).toBe("/acme/infra");
    // Tidewater is not the workspace: its repositories are a click away.
    expect(nav.queryByRole("link", { name: "ledger" })).toBeNull();
    const tidewater = nav.getByRole("button", { name: "Tidewater" });
    expect(tidewater.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tidewater);
    expect(nav.getByRole("link", { name: "ledger" }).getAttribute("href")).toBe(
      "/tidewater/ledger",
    );
    fireEvent.click(nav.getByRole("button", { name: "Your work" }));
    expect(nav.queryByRole("link", { name: "Changes" })).toBeNull();
  });

  it("frames a repository's pages, with the repository marked and named in the bar", async () => {
    open("/acme/infra");
    // The repository's sections are in the bar, its pull requests as its branches.
    const sections = within(await screen.findByRole("navigation", { name: "Repository" }, wait));
    expect(sections.getByRole("link", { name: /Branches/ }).getAttribute("href")).toBe(
      "/acme/infra/pulls",
    );
    expect(sections.getByRole("link", { name: "Code" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: /Pull requests/ })).toBeNull();
    expect(sidebar().getByRole("link", { name: "infra" }).getAttribute("aria-current")).toBe(
      "page",
    );
    // Named once, in the bar, with its lock: the page has no header of its own.
    const bar = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(bar.getByRole("link", { name: "infra" }).getAttribute("href")).toBe("/acme/infra");
    expect(bar.getByRole("img", { name: "Private" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "infra" })).toHaveLength(2);
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("button", { name: /Star/ })).toBeTruthy();
    expect(header.getByRole("button", { name: /Fork/ })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Site" })).toBeNull();
  });

  it("lists a repository's pull requests as its branches, one line each", async () => {
    open("/acme/infra/pulls");
    const list = within(await screen.findByRole("list", { name: "Branches" }, wait));
    const row = list.getByRole("link", { name: "Peer with the shared services VPC" });
    expect(row.getAttribute("href")).toBe("/acme/infra/pulls/12");
    expect(row.closest("li")!.textContent).toContain("feature/vpc-peering");
    expect(list.getByRole("img", { name: "Approved" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search branches" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New pull request" })).toBeTruthy();
  });

  it("names a branch page in the bar, with the mode switch beside the sections", async () => {
    open("/acme/infra/pulls/12");
    const title = await screen.findByRole(
      "heading",
      { name: "Peer with the shared services VPC" },
      wait,
    );
    // The number is a quiet part of the line above the title, not of the title.
    expect(title.textContent).not.toContain("#12");
    const bar = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(bar.getByText("Peer with the shared services VPC")).toBeTruthy();
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("group", { name: "Open pull requests as" })).toBeTruthy();
    expect(
      within(screen.getByRole("main")).queryByRole("group", { name: "Open pull requests as" }),
    ).toBeNull();
    expect(screen.queryByText(/wants to merge/)).toBeNull();
  });

  it("switches to classic from the account menu, and back from the top bar's", async () => {
    open("/");
    await screen.findByRole("heading", { name: /active branches/ }, wait);
    fireEvent.click(screen.getByRole("button", { name: "Account menu for Mara Lindqvist" }));
    const classic = await screen.findByRole("menuitemradio", { name: "Classic" });
    expect(classic.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByRole("menuitemradio", { name: "Branch page" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(classic);

    // The top-nav shell and the home page as it was.
    expect(await screen.findByRole("navigation", { name: "Site" }, wait)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Recent pushes" }, wait)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
    expect((await api.review.mode()).mode).toBe("classic");

    fireEvent.click(screen.getByRole("button", { name: "Account menu for Mara Lindqvist" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Branch page" }));
    expect(await screen.findByRole("navigation", { name: "Workspace" }, wait)).toBeTruthy();
  });

  it("is not for a signed-out reader", async () => {
    setScenario("signed-out");
    open("/");
    expect(await screen.findByRole("navigation", { name: "Site" }, wait)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Repositories" }, wait)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
    cleanup();
    queryClient.clear();
    open("/changes");
    expect(await screen.findByText("Sign in to see your work", {}, wait)).toBeTruthy();
  });
});

describe("the lists", () => {
  it("shows every open branch, then only the reader's, then the merged ones", async () => {
    const router = open("/changes");
    const list = () => within(screen.getByRole("list", { name: "Changes" }));
    await screen.findByRole("list", { name: "Changes" }, wait);
    expect(list().getAllByRole("listitem")).toHaveLength(15);
    expect(sidebar().getByRole("link", { name: "Changes" }).getAttribute("aria-current")).toBe(
      "page",
    );

    fireEvent.click(
      within(screen.getByRole("group", { name: "Author" })).getByRole("button", { name: "Mine" }),
    );
    await waitFor(() => expect(list().getAllByRole("listitem")).toHaveLength(4), wait);
    expect(router.state.location.searchStr).toBe("?author=mine");

    fireEvent.click(
      within(screen.getByRole("group", { name: "State" })).getByRole("button", { name: "Merged" }),
    );
    await waitFor(() => expect(list().getAllByRole("listitem")).toHaveLength(1), wait);
    expect(list().getByRole("img", { name: "Merged" })).toBeTruthy();
    expect(router.state.location.searchStr).toBe("?state=merged&author=mine");
  });

  it("opens Changes on the filter a link names", async () => {
    open("/changes?author=team");
    await screen.findByRole("list", { name: "Changes" }, wait);
    expect(
      within(screen.getByRole("list", { name: "Changes" })).getAllByRole("listitem"),
    ).toHaveLength(11);
    expect(
      within(screen.getByRole("group", { name: "Author" }))
        .getByRole("button", { name: "Team" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("lists the comments that mention the reader, each linked to its thread", async () => {
    open("/mentions");
    const list = within(await screen.findByRole("list", { name: "Mentions" }, wait));
    const rows = list.getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(rows[0]!.textContent).toContain("@mara the route table ids");
    expect(
      list.getByRole("link", { name: "Peer with the shared services VPC" }).getAttribute("href"),
    ).toBe("/acme/infra/pulls/12");
    // An issue's mention goes to the issue.
    expect(
      list.getByRole("link", { name: "Rotate the database master password" }).getAttribute("href"),
    ).toBe("/acme/infra/issues/15");
  });

  it("keeps the lists for someone in classic mode, under the top bar", async () => {
    await api.review.setMode({ payload: { mode: "classic" } });
    open("/changes");
    expect(await screen.findByRole("list", { name: "Changes" }, wait)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Changes" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Site" })).toBeTruthy();
  });
});
