/**
 * The sidebar shell and the pages of someone's work against the dev mock,
 * through the real router: home, Changes and its filters, Mentions, a
 * repository inside the shell, its Branches tab, and the reduced sidebar of
 * a signed-out reader.
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

afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  setScenario("signed-in");
});

const sidebar = () => within(screen.getByRole("navigation", { name: "Workspace" }));

/** The home's Start work: a link to one repository's form, or a menu button. */
const startWork = (): HTMLElement =>
  screen.queryByRole("link", { name: "Start work" }) ??
  screen.getByRole("button", { name: "Start work" });

describe("home", () => {
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
    expect(working.getAttribute("href")).toBe("/acme/edge-router/branches/feature/health-checks");
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
    ).toBe("/acme/infra/branches/feature/vpc-peering?v=3&diff=since");
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
    // Linked by the event's own key.
    expect(
      activity
        .getAllByRole("link", { name: "Peer with the shared services VPC" })[0]!
        .getAttribute("href"),
    ).toBe("/acme/infra/branches/feature/vpc-peering");
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
    // Start work stays on the right with branches open, not only on an empty home.
    expect(startWork()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Workspace: Tidewater" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mara Lindqvist" }));
    expect(await screen.findByRole("heading", { name: "No active branches" }, wait)).toBeTruthy();
    const start = startWork();
    if (start.tagName === "A") {
      expect(start.getAttribute("href")).toMatch(/^\/mara\/[^/]+\/start$/);
    } else {
      // Several repositories: a menu of them, each to its own form.
      fireEvent.click(start);
      const items = await screen.findAllByRole("menuitem");
      expect(items.length).toBeGreaterThan(1);
      for (const item of items) expect(item.getAttribute("href")).toMatch(/^\/mara\/[^/]+\/start$/);
    }
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
  it("lists the reader's work and only the selected workspace's repositories", async () => {
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
    // One flat list under the workspace's name, which does not fold.
    const acme = within(nav.getByRole("list", { name: "Acme" }));
    expect(acme.getByRole("link", { name: "infra" }).getAttribute("href")).toBe("/acme/infra");
    expect(nav.queryByRole("button", { name: "Acme" })).toBeNull();
    // No other namespace is in the sidebar, folded or not.
    expect(nav.queryByRole("link", { name: "ledger" })).toBeNull();
    expect(nav.queryByText("Tidewater")).toBeNull();
    expect(nav.queryByText("Mara Lindqvist")).toBeNull();
    fireEvent.click(nav.getByRole("button", { name: "Your work" }));
    expect(nav.queryByRole("link", { name: "Changes" })).toBeNull();
  });

  it("swaps the list when another workspace is picked", async () => {
    open("/");
    await screen.findByRole("heading", { name: /active branches/ }, wait);
    fireEvent.click(screen.getByRole("button", { name: "Workspace: Acme" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Tidewater" }));
    const nav = sidebar();
    const tidewater = within(await nav.findByRole("list", { name: "Tidewater" }, wait));
    expect(tidewater.getByRole("link", { name: "ledger" }).getAttribute("href")).toBe(
      "/tidewater/ledger",
    );
    expect(nav.queryByRole("list", { name: "Acme" })).toBeNull();
    expect(nav.queryByRole("link", { name: "edge-router" })).toBeNull();
  });

  it("switches to the workspace of the repository shown", async () => {
    open("/tidewater/ledger");
    await screen.findByRole("navigation", { name: "Repository" }, wait);
    const nav = sidebar();
    const tidewater = within(await nav.findByRole("list", { name: "Tidewater" }, wait));
    expect(tidewater.getByRole("link", { name: "ledger" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(nav.queryByRole("list", { name: "Acme" })).toBeNull();
    expect(nav.queryByRole("list", { name: "Viewing" })).toBeNull();
    // The choice is kept: the switcher and the pages that follow it say the same.
    await waitFor(() => expect(localStorage.getItem("git-workspace")).toBe("tidewater"), wait);
    expect(screen.getByRole("button", { name: "Workspace: Tidewater" })).toBeTruthy();
  });

  it("goes to the picked workspace's home when one is picked on a repository", async () => {
    open("/tidewater/ledger");
    await screen.findByRole("navigation", { name: "Repository" }, wait);
    fireEvent.click(await screen.findByRole("button", { name: "Workspace: Tidewater" }, wait));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Acme" }));
    // Staying on Tidewater's repository would pull the sidebar back to Tidewater.
    await screen.findByRole("heading", { name: /active branches/ }, wait);
    expect(await sidebar().findByRole("list", { name: "Acme" }, wait)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspace: Acme" })).toBeTruthy();
  });

  it("keeps the workspace on somebody else's repository, which it shows as Viewing", async () => {
    open("/jonas/edge-router");
    await screen.findByRole("navigation", { name: "Repository" }, wait);
    const nav = sidebar();
    const viewing = within(await nav.findByRole("list", { name: "Viewing" }, wait));
    expect(viewing.getByRole("link", { name: "edge-router" }).getAttribute("href")).toBe(
      "/jonas/edge-router",
    );
    expect(nav.getByRole("list", { name: "Acme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspace: Acme" })).toBeTruthy();
    expect(localStorage.getItem("git-workspace")).toBeNull();
  });

  it("frames a repository's pages, with the repository marked and named in the bar", async () => {
    open("/acme/infra");
    // The repository's sections are in the bar.
    const sections = within(await screen.findByRole("navigation", { name: "Repository" }, wait));
    expect(sections.getByRole("link", { name: /Branches/ }).getAttribute("href")).toBe(
      "/acme/infra/branches",
    );
    expect(sections.getByRole("link", { name: "Code" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: /Pull/ })).toBeNull();
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

  it("lists a repository's branches by their pages, one line each, named by the branch", async () => {
    open("/acme/infra/branches");
    const list = within(await screen.findByRole("list", { name: "Branches" }, wait));
    const row = list.getByRole("link", { name: "Peer with the shared services VPC" });
    expect(row.getAttribute("href")).toBe("/acme/infra/branches/feature/vpc-peering");
    expect(row.closest("li")!.textContent).toContain("feature/vpc-peering");
    expect(row.closest("li")!.textContent).not.toContain("#12");
    expect(list.getByRole("img", { name: "Approved" })).toBeTruthy();
    expect(
      list.getByRole("link", { name: "Staging budget alarm at 80 percent" }).getAttribute("href"),
    ).toBe("/acme/infra/branches/feature/budgets/staging-alarm");
    expect(screen.getByRole("searchbox", { name: "Search branches" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start work" }).getAttribute("href")).toBe(
      "/acme/infra/start",
    );
    expect(screen.queryByRole("link", { name: /New pull/i })).toBeNull();
    // The other view of the tab is every branch, to make and delete them.
    fireEvent.click(screen.getByRole("link", { name: /All branches/ }));
    const table = within(await screen.findByRole("table", { name: "Branches" }, wait));
    expect(
      table.getByRole("link", { name: /Peer with the shared services VPC/ }).getAttribute("href"),
    ).toBe("/acme/infra/branches/feature/vpc-peering");
    expect(screen.getByRole("button", { name: "New branch" })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Repository" }))
        .getByRole("link", { name: /Branches/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("names a branch page in the bar, with no number anywhere", async () => {
    open("/acme/infra/branches/feature/vpc-peering");
    const title = await screen.findByRole(
      "heading",
      { name: "Peer with the shared services VPC" },
      wait,
    );
    expect(title.textContent).not.toContain("#12");
    const bar = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(bar.getByText("Peer with the shared services VPC")).toBeTruthy();
    expect(within(screen.getByRole("main")).queryByText("#12")).toBeNull();
    expect(screen.queryByRole("group", { name: /Open .* as/ })).toBeNull();
    expect(screen.queryByText(/wants to merge/)).toBeNull();
  });

  it("marks the repositories an agent is working in", async () => {
    open("/");
    await screen.findByRole("heading", { name: /active branches/ }, wait);
    const nav = sidebar();
    await waitFor(() => {
      const marked = nav
        .getAllByRole("link")
        .filter((link) => link.querySelector("[data-agent-working]") !== null);
      expect(marked.length).toBeGreaterThan(0);
    }, wait);
  });

  it("is reduced for a signed-out reader: the site, Explore, the repository read, and Sign in", async () => {
    setScenario("signed-out");
    const router = open("/");
    // Nothing of theirs is here: home is Explore.
    await waitFor(() => expect(router.state.location.pathname).toBe("/explore"), wait);
    const site = within(await screen.findByRole("navigation", { name: "Site" }, wait));
    expect(site.getByRole("link", { name: "Explore" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Account menu/ })).toBeNull();
    cleanup();
    queryClient.clear();

    open("/acme/edge-router");
    const nav = within(await screen.findByRole("navigation", { name: "Site" }, wait));
    const repository = await nav.findByRole("link", { name: "edge-router" }, wait);
    expect(repository.getAttribute("href")).toBe("/acme/edge-router");
    expect(repository.getAttribute("aria-current")).toBe("page");
    // The owner is reached from the breadcrumb, not a row of its own.
    expect(nav.queryByRole("link", { name: "acme" })).toBeNull();
    // The same page as a member sees: the sections in the bar, no header of its own.
    expect(await screen.findByRole("navigation", { name: "Repository" }, wait)).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
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
    ).toBe("/acme/infra/branches/feature/vpc-peering");
    // An issue's mention goes to the issue.
    expect(
      list.getByRole("link", { name: "Rotate the database master password" }).getAttribute("href"),
    ).toBe("/acme/infra/issues/15");
  });
});

describe("bot accounts", () => {
  it("gives a bot a page with its picture and a badge, and nothing of its own", async () => {
    open("/claude");
    expect(await screen.findByRole("heading", { name: "Claude" }, wait)).toBeTruthy();
    const profile = within(screen.getByRole("region", { name: "Profile" }));
    expect(profile.getByText("Bot")).toBeTruthy();
    expect(
      profile.getByText("Commits made with Claude are attributed to this account."),
    ).toBeTruthy();
    expect(profile.getByRole("presentation", { hidden: true }).getAttribute("src")).toBe(
      "/assets/bots/claude-icon.svg",
    );
    // No repositories, stars or settings, and no namespace was asked for.
    expect(screen.queryByRole("navigation", { name: "Profile" })).toBeNull();
    expect(screen.queryByText(/Repositories|Stars|Settings|New repository/)).toBeNull();
    expect(screen.queryByText(/not found|No such/i)).toBeNull();
  });

  it("finds a bot's page whatever the case of the address", async () => {
    open("/Cursor");
    // The bar names the page by its address; the profile by the account.
    expect((await screen.findAllByRole("heading", { name: "Cursor" }, wait)).length).toBe(2);
    expect(
      screen.getByText("Commits made with Cursor are attributed to this account."),
    ).toBeTruthy();
  });

  it("names the bots on a commit list, each linked to its page", async () => {
    open("/acme/edge-router/commits");
    const row = (await screen.findByText("Log the route a request took", {}, wait)).closest("li")!;
    // Three faces, then the author and how many more.
    expect(row.textContent).toContain("mara");
    expect(row.textContent).toContain("2 others");
    expect(row.querySelector("[title='mara, Cursor, Claude']")).toBeTruthy();
    const one = screen.getByText("Answer 404 for a host with no routes").closest("li")!;
    expect(within(one).getByRole("link", { name: "Claude" }).getAttribute("href")).toBe("/claude");
    // Cursor wrote this one itself, under another name.
    const own = screen.getByText("Document the route weights").closest("li")!;
    expect(within(own).getByRole("link", { name: "Cursor" }).getAttribute("href")).toBe("/cursor");
    expect(own.textContent).not.toContain("Cursor Agent");
  });
});
