/**
 * The branch pages against the dev mock, through the real router: a page by
 * its key (slashes, a fork's, an earlier page of a name), the version rail,
 * dismissing a finding, the old numbered addresses, proposing a fork's
 * branch, starting work, the inbox, and a server that does not serve
 * traces, findings and instructions yet.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  fillPath,
  setTransport,
  type ApiCall,
  type Transport,
} from "../../../api/client";
import { queryClient } from "../../../api/queries";
import { routeTree } from "../../../routeTree.gen";

/** The dev mock's handlers as a transport, without its artificial delay. */
function mockTransport(): Transport {
  const handlers = import.meta.glob<{ default: Record<string, Record<string, unknown>> }>(
    "../../../mock/handlers/*.ts",
    { eager: true },
  );
  const table = new Map<string, (request: unknown) => unknown>();
  for (const module of Object.values(handlers)) {
    for (const [group, endpoints] of Object.entries(module.default)) {
      for (const [endpoint, handler] of Object.entries(endpoints ?? {})) {
        table.set(`${group}.${endpoint}`, handler as (request: unknown) => unknown);
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
vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
  // jsdom has no layout: dialogs open by attribute, and nothing scrolls.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  window.scrollTo = () => {};
  // The diff and the file tree watch their own size, which jsdom never changes.
  class NoLayoutObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("ResizeObserver", NoLayoutObserver);
  vi.stubGlobal("IntersectionObserver", NoLayoutObserver);
});

/** The URLs the client would have asked for, filled as `httpTransport` fills them. */
let asked: string[] = [];

/** Every call goes to the mock, unless `refuse` names its group: a server that does not serve it yet. */
function serve(refuse: ReadonlyArray<string> = []) {
  setTransport((call: ApiCall) => {
    asked.push(fillPath(call.path, call.request.params ?? {}));
    return refuse.includes(call.group)
      ? Promise.reject(new ApiError(503, "Not available yet", "not_implemented"))
      : mock(call);
  });
}

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
  asked = [];
  serve();
});

const wait = { timeout: 5000 };
const PEERING = "/acme/infra/branches/feature/vpc-peering";
const pathOf = (router: ReturnType<typeof open>) =>
  decodeURIComponent(router.state.location.pathname);

// Before the branch page's tests: one of them marks the peering branch reviewed, which takes it out of the inbox.
describe("the inbox", () => {
  it("lists what waits on the reader, each opening on what is new", async () => {
    serve();
    open("/reviews");
    const list = await screen.findByRole("list", { name: "Reviews" }, wait);
    const first = within(list).getAllByRole("listitem")[0]!;
    expect(first.textContent).toContain("Peer with the shared services VPC");
    expect(first.textContent).toContain("1 must fix");
    expect(
      within(first)
        .getByRole("link", { name: /Peer with/ })
        .getAttribute("href"),
    ).toMatch(/^\/acme\/infra\/branches\/feature\/vpc-peering\?v=\d+&diff=since$/);
  });
});

describe("a branch page's address", () => {
  it("is the branch, slashes and all, one encoded segment to the API", async () => {
    serve();
    const router = open("/acme/infra/branches/feature/budgets/staging-alarm");
    expect(
      await screen.findByRole("heading", { name: "Staging budget alarm at 80 percent" }, wait),
    ).toBeTruthy();
    expect(asked).toContain("/api/repos/acme/infra/branches/feature%2Fbudgets%2Fstaging-alarm");
    expect(pathOf(router)).toBe("/acme/infra/branches/feature/budgets/staging-alarm");
    // The page is named by its branch: no number on it or in the window's title.
    expect(within(screen.getByRole("main")).queryByText(/#1[78]\b/)).toBeNull();
    await waitFor(() => expect(document.title).not.toMatch(/#\d/), wait);
    expect(document.title).toContain("Staging budget alarm at 80 percent");
    // Its tabs are in the query: a splat has no room for a suffix.
    expect(screen.getByRole("link", { name: /^Commits/ }).getAttribute("href")).toBe(
      "/acme/infra/branches/feature/budgets/staging-alarm?tab=commits",
    );
  });

  it("names an earlier page of a reused name with ~n, and settles a longer key on the page's own", async () => {
    serve();
    const router = open("/acme/infra/branches/feature/budgets/staging-alarm~1");
    expect(
      await screen.findByRole("heading", { name: "Budget alarm for staging" }, wait),
    ).toBeTruthy();
    expect(pathOf(router)).toBe("/acme/infra/branches/feature/budgets/staging-alarm~1");
    expect(asked).toContain("/api/repos/acme/infra/branches/feature%2Fbudgets%2Fstaging-alarm~1");
    cleanup();
    queryClient.clear();

    // `~2` is the open page, whose own key is the bare name.
    const second = open("/acme/infra/branches/feature/budgets/staging-alarm~2?tab=commits");
    expect(
      await screen.findByRole("heading", { name: "Staging budget alarm at 80 percent" }, wait),
    ).toBeTruthy();
    await waitFor(
      () => expect(pathOf(second)).toBe("/acme/infra/branches/feature/budgets/staging-alarm"),
      wait,
    );
    expect(second.state.location.search).toEqual({ tab: "commits" });
  });

  it("names a fork's branch by the fork, and marks it in the list", async () => {
    serve();
    open("/acme/edge-router/branches/jonas/edge-router:fix/lowercase-hosts");
    expect(
      await screen.findByRole("heading", { name: "Match hosts case-insensitively" }, wait),
    ).toBeTruthy();
    expect(asked).toContain(
      "/api/repos/acme/edge-router/branches/jonas%2Fedge-router%3Afix%2Flowercase-hosts",
    );
    expect(screen.getAllByText("jonas/edge-router:fix/lowercase-hosts").length).toBeGreaterThan(0);
    cleanup();
    queryClient.clear();

    open("/acme/edge-router/branches");
    const list = within(await screen.findByRole("list", { name: "Branches" }, wait));
    const row = list
      .getByRole("link", { name: "Match hosts case-insensitively" })
      .closest("li") as HTMLElement;
    expect(decodeURIComponent(within(row).getAllByRole("link")[0]!.getAttribute("href")!)).toBe(
      "/acme/edge-router/branches/jonas/edge-router:fix/lowercase-hosts",
    );
    expect(row.textContent).toContain("from fork");
  });

  it("moves every old numbered address to the page, its tab and anchor kept", async () => {
    serve();
    const cases: Array<[string, string, string]> = [
      ["/acme/infra/pulls/12", PEERING, ""],
      ["/acme/infra/pulls/12/commits", PEERING, "?tab=commits"],
      ["/acme/infra/pulls/12/checks", PEERING, "?tab=checks"],
      ["/acme/infra/pulls/12/files#diff-main.tf", PEERING, ""],
      ["/acme/infra/issues/12", PEERING, ""],
      ["/acme/infra/pulls/6", "/acme/infra/issues/6", ""],
      ["/acme/infra/pulls/start", "/acme/infra/start", ""],
      ["/acme/infra/pulls/new", "/acme/infra/branches", ""],
      ["/acme/infra/pulls?q=is%3Aclosed", "/acme/infra/branches", "?q=is%3Aclosed"],
    ];
    for (const [from, to, query] of cases) {
      const router = open(from);
      await waitFor(() => expect(pathOf(router)).toBe(to), wait);
      expect(router.state.location.searchStr).toBe(query);
      if (from.includes("#")) expect(router.state.location.hash).toBe("diff-main.tf");
      cleanup();
      queryClient.clear();
    }
  });
});

describe("the branch page", () => {
  it("is the rail, the ask, the trace and the merge block", async () => {
    serve();
    open(PEERING);
    const rail = await screen.findByRole("navigation", { name: "Versions" }, wait);
    expect(
      within(rail)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Version 1", "Version 2", "Version 3"]);
    // Where the reader last reviewed, the forced push, and what is new since.
    const [, v2, v3] = within(rail).getAllByRole("button");
    expect(v2!.textContent).toContain("Forced");
    expect(v2!.textContent).toContain("Reviewed");
    expect(v3!.textContent).toContain("New");
    expect(v3!.getAttribute("aria-current")).toBe("true");

    expect(screen.getByText("1 must-fix finding to settle")).toBeTruthy();
    // The page's own link, not the sidebar's Reviews.
    const page = within(screen.getByRole("main"));
    expect(page.getByRole("link", { name: /^Review/ }).getAttribute("href")).toBe(PEERING);
    expect(screen.queryByRole("link", { name: /Files changed/ })).toBeNull();
    expect(page.queryByText("#12")).toBeNull();
    // It opens on what changed since v2, with v3's trace above its lines.
    expect(await screen.findByText("v2 to v3", { exact: false }, wait)).toBeTruthy();
    expect(await screen.findByText("and the diagram redrawn", { exact: false }, wait)).toBeTruthy();
    // The merge box holds on the must-fix finding and offers an administrator the override.
    const merge = screen.getByRole("region", { name: "Merge" });
    expect(within(merge).getByText("1 must-fix finding open")).toBeTruthy();
    expect(within(merge).getByRole("button", { name: "Override" })).toBeTruthy();
    expect(within(merge).queryByRole("button", { name: /^Merge$/ })).toBeNull();
    expect(within(merge).getByRole("list", { name: "Blocked by" }).textContent).toContain(
      "1 must-fix finding is open",
    );
    // The agent and what was sent to it.
    expect(screen.getByRole("heading", { name: "Agent" }).parentElement!.textContent).toContain(
      "Infrawrench agent",
    );
    expect(screen.getAllByText("Answered by v3").length).toBeGreaterThan(0);
  });

  it("shows one step, the whole change, and says when a diff is not exact", async () => {
    serve();
    const router = open(`${PEERING}?v=2&diff=step`);
    expect(await screen.findByText("v1 to v2", { exact: false }, wait)).toBeTruthy();
    expect(await screen.findByRole("note", {}, wait)).toHaveProperty(
      "textContent",
      expect.stringContaining("rebased between v1 and v2"),
    );
    expect(
      await screen.findByText("Staging peers with shared services", { exact: false }, wait),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Whole change" }));
    await waitFor(
      () => expect(router.state.location.search).toEqual({ v: 2, diff: "whole" }),
      wait,
    );
    expect(await screen.findByText("v2 against its base", { exact: false }, wait)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Version 3" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ v: 3 }), wait);
    // Marking it reviewed moves the mark and leaves nothing new.
    fireEvent.click(await screen.findByRole("button", { name: "Mark v3 reviewed" }, wait));
    expect(await screen.findByText("Reviewed up to v3", {}, wait)).toBeTruthy();
    const list = await api.versions.list({
      params: { owner: "acme", repo: "infra", branch: "feature/vpc-peering" },
    });
    expect(list.viewerReviewed).toBe(3);
  });

  it("has its commits and checks as tabs in the query", async () => {
    serve();
    open(`${PEERING}?tab=commits`);
    expect(await screen.findByText(/^Commits on /, {}, wait)).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Branch" }))
        .getByRole("link", { name: /^Commits/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByRole("navigation", { name: "Versions" })).toBeNull();
    cleanup();
    queryClient.clear();
    open(`${PEERING}?tab=checks`);
    expect(await screen.findByText("Statuses", {}, wait)).toBeTruthy();
  });

  it("dismisses a finding with a reason, and reopens it", async () => {
    serve();
    open(`${PEERING}?v=3&diff=whole`);
    const panel = (await screen.findByRole("heading", { name: "Findings" }, wait)).closest(
      "#findings",
    ) as HTMLElement;
    const row = within(panel).getByText("The shared VPC's id is written out").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Show finding" }));
    fireEvent.click(within(row).getByRole("button", { name: "Dismiss" }));
    const dialog = within(row)
      .getAllByRole("dialog", { hidden: true })
      .find((item) => item.textContent?.includes("Dismiss finding"))!;
    const confirm = within(dialog).getByRole("button", { name: "Dismiss", hidden: true });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Tracked in a follow-up" },
    });
    fireEvent.click(confirm);
    await waitFor(
      () =>
        expect(
          within(panel).getByText("The shared VPC's id is written out").closest("li")!.textContent,
        ).toContain("Dismissed"),
      wait,
    );
    const after = within(panel).getByText("The shared VPC's id is written out").closest("li")!;
    expect(after.textContent).toContain("Tracked in a follow-up");
    fireEvent.click(within(after).getByRole("button", { name: "Reopen" }));
    await waitFor(
      () =>
        expect(
          within(panel).getByText("The shared VPC's id is written out").closest("li")!.textContent,
        ).not.toContain("Dismissed"),
      wait,
    );
  });

  it("leaves out what the server does not serve yet instead of failing", async () => {
    serve(["traces", "findings", "instructions", "t3"]);
    open(`${PEERING}?v=3&diff=whole`);
    expect(await screen.findByRole("navigation", { name: "Versions" }, wait)).toBeTruthy();
    expect(await screen.findByText("v3 against its base", { exact: false }, wait)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Findings" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Instructions" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "Merge" })).toBeTruthy();
  });
});

describe("proposing a fork's branch", () => {
  it("opens its page in the parent and goes there; again goes to the same page", async () => {
    serve();
    const router = open("/mara/infra/branches?view=all");
    const cell = await screen.findByRole("link", { name: "docs/peering-notes" }, wait);
    const row = cell.closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Propose to acme/infra" }));
    await waitFor(
      () => expect(pathOf(router)).toBe("/acme/infra/branches/mara/infra:docs/peering-notes"),
      wait,
    );
    expect(await screen.findByRole("heading", { name: "Peering notes" }, wait)).toBeTruthy();
    cleanup();
    queryClient.clear();

    // Proposed already: the same button lands on the page it has.
    const again = open("/mara/infra/branches?view=all");
    const second = (await screen.findByRole("link", { name: "docs/peering-notes" }, wait)).closest(
      "tr",
    ) as HTMLElement;
    fireEvent.click(within(second).getByRole("button", { name: "Propose to acme/infra" }));
    await waitFor(
      () => expect(pathOf(again)).toBe("/acme/infra/branches/mara/infra:docs/peering-notes"),
      wait,
    );
  });
});

describe("start work", () => {
  it("names the branch from the ask, offers the agents, and goes to the new branch's page", async () => {
    serve();
    const router = open("/acme/infra/start");
    const ask = await screen.findByPlaceholderText("What should change", {}, wait);
    const agents = screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
    expect(agents).toEqual(["infrawrench", "t3", "mcp"]);
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Another agent/ }));
    expect(
      screen.getByText(
        "claude mcp add --transport http infrawrench-git https://git.infrawrench.com/mcp",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("codex mcp add infrawrench-git --url https://git.infrawrench.com/mcp"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /T3 Code/ }));
    expect(await screen.findByLabelText("Environment", {}, wait)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Infrawrench/ }));

    fireEvent.change(ask, { target: { value: "Tag every subnet with its tier" } });
    const branch = screen.getByLabelText("Branch") as HTMLInputElement;
    expect(branch.value).toBe("work/tag-every-subnet-with-its-tier");
    fireEvent.click(screen.getByRole("button", { name: "Start work" }));
    await waitFor(
      () => expect(pathOf(router)).toBe("/acme/infra/branches/work/tag-every-subnet-with-its-tier"),
      wait,
    );
    expect(
      await screen.findByText("The agent is working on v1", { exact: false }, wait),
    ).toBeTruthy();
    const made = await api.branches.get({
      params: { owner: "acme", repo: "infra", branch: "work/tag-every-subnet-with-its-tier" },
    });
    expect(made).toMatchObject({
      draft: true,
      headRef: "work/tag-every-subnet-with-its-tier",
      body: "Tag every subnet with its tier",
    });
  });
});

describe("repository review settings", () => {
  it("switches review agents and picks the reviewers", async () => {
    serve();
    open("/acme/infra/settings/review");
    const tests = (await screen.findByLabelText("Tests", {}, wait)) as HTMLInputElement;
    expect(tests.checked).toBe(false);
    expect(screen.queryByRole("button", { name: /Branch pages/ })).toBeNull();
    fireEvent.click(tests);
    await waitFor(
      () => expect((screen.getByLabelText("Tests") as HTMLInputElement).checked).toBe(true),
      wait,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Switch off: Must-fix findings block merging" }),
    );
    await waitFor(
      async () =>
        expect(
          (await api.reviewSettings.get({ params: { owner: "acme", repo: "infra" } }))
            .mustFixBlocksMerge,
        ).toBe(false),
      wait,
    );
    await api.reviewSettings.update({
      params: { owner: "acme", repo: "infra" },
      payload: {
        mustFixBlocksMerge: true,
        reviewerKinds: ["general", "security", "terraform", "intent"],
      },
    });
  });
});
