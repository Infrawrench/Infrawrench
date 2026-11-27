/**
 * The branch pages against the dev mock, through the real router: a page by
 * its key (slashes, a fork's, an earlier page of a name), the version rail,
 * dismissing a finding, the old numbered addresses, proposing a fork's
 * branch, starting work, the inbox, a server that does not serve traces,
 * findings and instructions yet, findings in a repository whose review
 * agents are off, and a merged branch whose versions are pruned.
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
    // Commits group by day, and the mock's dates are relative to now: late in the day there are two.
    expect((await screen.findAllByText(/^Commits on /, {}, wait)).length).toBeGreaterThan(0);
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

describe("findings from a reviewer outside the forge", () => {
  const HEALTH = "/acme/edge-router/branches/feature/health-checks";

  it("are listed where the repository's review agents are off", async () => {
    serve();
    const state = await api.versions.branchState({
      params: { owner: "acme", repo: "edge-router", branch: "feature/health-checks" },
    });
    expect(state.settings.reviewAgentsEnabled).toBe(false);

    open(HEALTH);
    const panel = (await screen.findByRole("heading", { name: "Findings" }, wait)).closest(
      "#findings",
    ) as HTMLElement;
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(panel.textContent).toContain("Nothing asks whether an upstream is healthy");
    expect(panel.textContent).toContain("claude-review");
    expect(panel.textContent).toContain("1 must fix");
    // The forge's own agents are off, so there is nothing of theirs to ask again.
    expect(within(panel).queryByRole("button", { name: /Review again/ })).toBeNull();
    // The line under the title and the rail's card count them like any others.
    expect(screen.getByText("1 must-fix finding to settle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Version 1" }).getAttribute("title")).toContain(
      "3 findings",
    );
  });

  it("leave no empty list where there are none and the agents are off", async () => {
    serve();
    open("/acme/edge-router/branches/jonas/edge-router:fix/lowercase-hosts");
    expect(await screen.findByRole("region", { name: "Merge" }, wait)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Findings" })).toBeNull();
  });
});

describe("a merged branch whose versions are pruned", () => {
  const FLOW_LOGS = "/acme/infra/branches/feature/flow-logs";

  it("keeps its versions, trace and findings, and reads the whole change from the merge", async () => {
    serve();
    open(FLOW_LOGS);
    const rail = await screen.findByRole("navigation", { name: "Versions" }, wait);
    const cards = within(rail).getAllByRole("button");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Version 1",
      "Version 2",
    ]);
    expect(cards[0]!.getAttribute("title")).toBe(
      "Pushed by Claude Code · 3 findings · Has a trace · Commits no longer kept",
    );
    // The newest version is what was merged, and the merge commit still has it.
    const note = await screen.findByRole("note", {}, wait);
    expect(note.textContent).toContain(
      "The commits of v2 are no longer kept. This is the change as it was merged",
    );
    expect(within(note).getByRole("link").getAttribute("href")).toBe(
      "/acme/infra/commit/28324628b9350fd4337ff45c37b7a89d40a5079b",
    );
    expect(await screen.findByText("v2 against its base", { exact: false }, wait)).toBeTruthy();
    // Merged long ago and the list is still there, each finding with an address of its own.
    const panel = (await screen.findByRole("heading", { name: "Findings" }, wait)).closest(
      "#findings",
    ) as HTMLElement;
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.id.startsWith("finding-"))).toBe(true);
    expect(panel.textContent).toContain("Merge allowed past it");
  });

  it("says so plainly when a pruned version's own diff is gone, and still shows its trace", async () => {
    serve();
    open(`${FLOW_LOGS}?v=1&diff=whole`);
    const note = await screen.findByRole("note", {}, wait);
    expect(note.textContent).toContain(
      "The change at v1 cannot be shown: its commits were removed 30 days after the branch was merged.",
    );
    expect(note.textContent).toContain("The change as merged is commit 2832462");
    expect(screen.queryByRole("alert")).toBeNull();
    const recorded = screen.getByRole("list", { name: "Recorded for v1" });
    expect(recorded.textContent).toContain("Let an environment send its VPC flow logs");
    expect(recorded.textContent).toContain("One aws_flow_log with a count");

    cleanup();
    queryClient.clear();
    open(`${FLOW_LOGS}?v=2&diff=step`);
    expect((await screen.findByRole("note", {}, wait)).textContent).toContain(
      "What v2 changed since an earlier version cannot be shown",
    );
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

/** The Model field once the environment's models are in, showing `selected`. */
async function modelField(
  scope: Pick<typeof screen, "getByLabelText">,
  selected: string,
): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const field = scope.getByLabelText("Model") as HTMLSelectElement;
    expect(field.selectedOptions[0]?.textContent).toBe(selected);
    return field;
  }, wait);
}

describe("start work", () => {
  it("names the branch from the ask, offers the agents, and goes to the new branch's page", async () => {
    serve();
    const router = open("/acme/infra/start");
    await screen.findByPlaceholderText("What should change", {}, wait);
    const agents = screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
    expect(agents).toEqual(["t3", "mcp"]);
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByLabelText("Environment", {}, wait)).toBeTruthy();

    // Another agent starts work itself: how to install the server, and nothing to submit.
    fireEvent.click(screen.getByRole("radio", { name: /Another agent/ }));
    for (const snippet of [
      "claude mcp add --transport http infrawrench-git https://git.infrawrench.com/mcp",
      "codex mcp add infrawrench-git --url https://git.infrawrench.com/mcp",
      "codex mcp login infrawrench-git",
    ]) {
      expect(screen.getByText(snippet)).toBeTruthy();
    }
    expect(screen.getByText(/"url": "https:\/\/git\.infrawrench\.com\/mcp"/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy the Cursor configuration" })).toBeTruthy();
    expect(screen.getByText("start_work")).toBeTruthy();
    expect(screen.queryByPlaceholderText("What should change")).toBeNull();
    expect(screen.queryByLabelText("Branch")).toBeNull();
    expect(screen.queryByLabelText("Environment")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start work" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /T3 Code/ }));
    const ask = await screen.findByPlaceholderText("What should change", {}, wait);
    expect(await screen.findByLabelText("Environment", {}, wait)).toBeTruthy();

    fireEvent.change(ask, { target: { value: "Tag every subnet with its tier" } });
    const branch = screen.getByLabelText("Branch") as HTMLInputElement;
    expect(branch.value).toBe("work/tag-every-subnet-with-its-tier");
    // The model is asked for, by name, starting at the project's default and its reasoning level.
    const model = await modelField(screen, "Claude Opus 5.5");
    expect(
      [...model.querySelectorAll("optgroup")].map((group) => [
        group.label,
        [...group.querySelectorAll("option")].map((option) => option.textContent),
      ]),
    ).toEqual([
      ["Codex", ["GPT-6 Astra"]],
      ["Claude", ["Claude Opus 5.5", "Claude Haiku 5.5"]],
    ]);
    const reasoning = screen.getByLabelText("Reasoning") as HTMLSelectElement;
    expect(reasoning.value).toBe("high");
    expect([...reasoning.options].map((option) => option.textContent)).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra high",
    ]);
    // A model with no levels has no Reasoning field.
    fireEvent.change(model, { target: { value: "claudeAgent\nclaude-haiku-5-5" } });
    expect(screen.queryByLabelText("Reasoning")).toBeNull();
    fireEvent.change(model, { target: { value: "claudeAgent\nclaude-opus-5-5" } });
    fireEvent.change(screen.getByLabelText("Reasoning"), { target: { value: "xhigh" } });
    // A thread that already runs has its model: nothing to choose.
    fireEvent.change(screen.getByLabelText("Thread"), { target: { value: "t3thread_peering" } });
    expect(screen.queryByLabelText("Model")).toBeNull();
    fireEvent.change(screen.getByLabelText("Thread"), { target: { value: "" } });
    expect((screen.getByLabelText("Reasoning") as HTMLSelectElement).value).toBe("xhigh");
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
    // The thread was started with what was chosen, and the page says which model it runs.
    const { agent } = await api.agents.get({
      params: { owner: "acme", repo: "infra", branch: "work/tag-every-subnet-with-its-tier" },
    });
    expect(agent?.externalRefs).toMatchObject({
      modelProviderId: "claudeAgent",
      modelId: "claude-opus-5-5",
      reasoningLevel: "xhigh",
    });
    expect(agent?.externalRefs["modelPickedBy"]).toBeUndefined();
    expect(await screen.findByText("Claude Opus 5.5, extra high reasoning", {}, wait)).toBeTruthy();
  });

  it("waits for a model when the project has none, shows a launch that failed, and tries again", async () => {
    serve();
    const router = open("/acme/infra/start");
    const ask = await screen.findByPlaceholderText("What should change", {}, wait);
    fireEvent.change(ask, { target: { value: "Rotate the bastion keys" } });
    fireEvent.change(await screen.findByLabelText("Environment", {}, wait), {
      target: { value: "t3env_mini" },
    });
    // This environment's project has no default model: nothing is chosen, and Start waits.
    const model = await modelField(screen, "Choose a model");
    const start = screen.getByRole("button", { name: "Start work" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.queryByLabelText("Reasoning")).toBeNull();
    fireEvent.change(model, { target: { value: "codex\ngpt-6-astra" } });
    // The model's own level to begin with.
    expect((screen.getByLabelText("Reasoning") as HTMLSelectElement).value).toBe("medium");
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(
      () => expect(pathOf(router)).toBe("/acme/infra/branches/work/rotate-the-bastion-keys"),
      wait,
    );

    // The environment refused the launch: the panel says so in its words, and is not "Idle".
    const failed = await screen.findByText("The thread did not start", {}, wait);
    const panel = failed.closest("section") as HTMLElement;
    expect(
      within(panel).getByText(
        "The branch is already checked out in another worktree. No thread was created.",
      ),
    ).toBeTruthy();
    expect(within(panel).queryByText("Idle")).toBeNull();
    expect(within(panel).queryByText(/Working/)).toBeNull();

    // Try again asks for the model too, and the same ask starts the thread.
    const again = await modelField(within(panel), "Choose a model");
    const retry = within(panel).getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.change(again, { target: { value: "codex\ngpt-6-astra" } });
    fireEvent.change(within(panel).getByLabelText("Reasoning"), { target: { value: "high" } });
    fireEvent.click(retry);
    expect(await within(panel).findByText("Idle", {}, wait)).toBeTruthy();
    expect(within(panel).getByText("Codex, GPT-6 Astra, high reasoning")).toBeTruthy();
    expect(within(panel).queryByText("The thread did not start")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Try again" })).toBeNull();
    const { agent } = await api.agents.get({
      params: { owner: "acme", repo: "infra", branch: "work/rotate-the-bastion-keys" },
    });
    expect(agent?.externalRefs["launchError"]).toBeUndefined();
    expect(agent?.externalRefs["threadId"]).toBeTruthy();
  });

  it("says when the forge picked the model, and when an instruction did not arrive", async () => {
    // The branch the test before this one made.
    serve();
    const params = { owner: "acme", repo: "infra", branch: "work/rotate-the-bastion-keys" };
    // An old branch tried again with nothing chosen: the forge picks, and the page says so.
    await api.agents.set({
      params,
      payload: { kind: "t3", displayName: "T3 Code on Mac mini", t3EnvironmentId: "t3env_mini" },
    });
    // The environment was away when a reviewer's instruction was sent.
    setTransport(async (call: ApiCall) => {
      const answer = (await mock(call)) as { agent?: { externalRefs: Record<string, string> } };
      if (call.group === "versions" && call.endpoint === "branchState" && answer.agent) {
        answer.agent.externalRefs["sendError"] = "The environment did not answer";
      }
      return answer;
    });
    open("/acme/infra/branches/work/rotate-the-bastion-keys");
    expect(
      await screen.findByText(
        "The last instruction did not reach the thread and will be sent again: The environment did not answer",
        {},
        wait,
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText("Claude Opus 5.5, high reasoning (picked automatically)", {}, wait),
    ).toBeTruthy();
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

describe("a version's notes and its files", () => {
  const WHOLE = `${PEERING}?v=3&diff=whole`;
  const MAIN = "modules/network/main.tf";
  const toggles = () =>
    screen.getAllByRole("button", { name: /^(Show|Hide) (docs|modules|environments)\// });

  it("tells the change before its code: doubts and decisions first, code only where it is needed", async () => {
    serve();
    open(WHOLE);
    const notes = await screen.findByRole("region", { name: "Review notes" }, wait);
    const first = within(notes).getByRole("region", { name: "Doubts and decisions" });
    const cards = within(first).getAllByRole("listitem");
    expect(cards.map((card) => card.getAttribute("data-kind"))).toEqual([
      "doubt",
      "doubt",
      "doubt",
      "doubt",
      "decision",
    ]);
    // Each names its file and lines. The first says the code is not needed: text alone.
    expect(within(cards[0]!).getByRole("link", { name: `${MAIN}:108-118` })).toBeTruthy();
    expect(
      within(cards[1]!).getByRole("link", { name: "environments/staging/main.tf:31" }),
    ).toBeTruthy();
    await waitFor(() => expect(cards[1]!.querySelector(".code-surface")).not.toBeNull(), wait);
    await waitFor(() => expect(cards[4]!.querySelector(".code-surface")).not.toBeNull(), wait);
    expect(cards[0]!.querySelector(".code-surface")).toBeNull();
    // Findings, what people said on its lines, then the rest of the trace in its order.
    expect(
      within(within(notes).getByRole("region", { name: "Findings" })).getByRole("link", {
        name: `${MAIN}:108-118`,
      }),
    ).toBeTruthy();
    expect(within(notes).getByRole("region", { name: "Comments" })).toBeTruthy();
    const steps = within(within(notes).getByRole("region", { name: "Steps" })).getAllByRole(
      "listitem",
    );
    expect(steps[0]!.textContent).toContain("Ask");
    expect(steps[1]!.textContent).toContain("modules/network/variables.tf:35-43");
    // An entry about no file has no place to name.
    expect(within(steps[0]!).queryByRole("link")).toBeNull();
  });

  it("lists the files closed, what must be fixed first, then the trace's order", async () => {
    serve();
    open(WHOLE);
    await screen.findByRole("region", { name: MAIN }, wait);
    expect(toggles().map((button) => button.getAttribute("aria-label"))).toEqual([
      `Show ${MAIN}`,
      "Show modules/network/variables.tf",
      "Show environments/staging/main.tf",
      "Show docs/peering.md",
      "Show docs/images/network.png",
    ]);
    expect(toggles().every((button) => button.getAttribute("aria-expanded") === "false")).toBe(
      true,
    );
    expect(screen.getByRole("region", { name: MAIN }).textContent).toContain("10 notes");

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(toggles().every((button) => button.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(screen.getByRole("button", { name: "Expand all" })).toHaveProperty("disabled", true);
    // One closed by hand stays closed; the rest follow "Collapse all".
    fireEvent.click(screen.getByRole("button", { name: "Hide docs/peering.md" }));
    expect(screen.getByRole("button", { name: "Show docs/peering.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(toggles().every((button) => button.getAttribute("aria-expanded") === "false")).toBe(
      true,
    );
  });

  it("opens a file on what its notes are about, says how much more there is, and shows it when asked", async () => {
    serve();
    const router = open(WHOLE);
    const notes = await screen.findByRole("region", { name: "Review notes" }, wait);
    // A card's lines open its file there.
    fireEvent.click(within(notes).getByRole("link", { name: `${MAIN}:181` }));
    const file = within(await screen.findByRole("region", { name: MAIN }, wait));
    expect(file.getByRole("button", { name: `Hide ${MAIN}` })).toBeTruthy();
    expect(await file.findByText("Showing 52 of 77 changed lines", {}, wait)).toBeTruthy();
    // Every note hangs on its lines, the doubt that does not need the code on its card included.
    expect(await file.findByText("A security group per peer", { exact: false }, wait)).toBeTruthy();
    expect(file.getByText("Nothing here accepts the connection", { exact: false })).toBeTruthy();
    const gap = file.getByRole("button", { name: "Show 25 more changed lines" });

    // The whole diff, and back to the lines in focus.
    fireEvent.click(file.getByRole("button", { name: "Show full diff" }));
    expect(file.getByText("All 77 changed lines")).toBeTruthy();
    expect(file.queryByRole("button", { name: /more changed lines/ })).toBeNull();
    fireEvent.click(file.getByRole("button", { name: "Show less" }));
    expect(file.getByText("Showing 52 of 77 changed lines")).toBeTruthy();

    // Showing the gap leaves nothing left out: the file is whole.
    fireEvent.click(
      gap.isConnected ? gap : file.getByRole("button", { name: /more changed lines/ }),
    );
    await waitFor(() => expect(file.queryByText(/^Showing /)).toBeNull(), wait);
    expect(file.queryByRole("button", { name: /more changed lines/ })).toBeNull();

    // Another view of the same page keeps what was opened.
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByRole("button", { name: `Hide ${MAIN}` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "This step" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ diff: "step" }), wait);
    expect(await screen.findByRole("button", { name: `Hide ${MAIN}` }, wait)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
  });

  it("says which CI job a note came from, and links to the line of its log", async () => {
    serve();
    open(WHOLE);
    const notes = await screen.findByRole("region", { name: "Review notes" }, wait);
    const run = (
      await api.ci.listRuns({ params: { owner: "acme", repo: "infra" }, query: {} })
    ).items.find((item) => item.headRef === "feature/vpc-peering" && item.status === "passed")!;
    const at = (line: number) => `/acme/infra/ci/runs/${run.id}?job=terraform%2Flint#L${line}`;

    // A doubt a job printed: a card like the agent's, marked with the job.
    const doubts = within(notes).getByRole("region", { name: "Doubts and decisions" });
    const doubt = within(doubts)
      .getAllByRole("listitem")
      .find((card) => card.textContent?.includes("tflint has no rules"))!;
    expect(doubt.getAttribute("data-kind")).toBe("doubt");
    expect(
      within(doubt).getByRole("link", { name: "From CI: terraform/lint" }).getAttribute("href"),
    ).toBe(at(7));
    expect(within(doubt).getByRole("link", { name: `${MAIN}:176` })).toBeTruthy();
    // Its run and line are the label's link, not a second row under the text.
    expect(within(doubt).queryByRole("link", { name: "CI run" })).toBeNull();
    // The agent's own entries carry no such mark.
    expect(
      within(doubts)
        .getAllByRole("listitem")
        .filter((card) => within(card).queryByRole("link", { name: /^From CI/ }) !== null),
    ).toHaveLength(1);

    // A finding a job printed: the same card as a reviewer's, the job where the reviewer's name is.
    const findings = within(notes).getByRole("region", { name: "Findings" });
    const finding = within(findings)
      .getAllByRole("listitem")
      .find((card) => card.textContent?.includes("DNS is allowed over UDP only"))!;
    expect(
      within(finding).getByRole("link", { name: "From CI: terraform/lint" }).getAttribute("href"),
    ).toBe(at(6));
    expect(finding.textContent).not.toContain("ci:terraform/lint");
    expect(within(finding).getByRole("link", { name: `${MAIN}:165-174` })).toBeTruthy();

    // The line it links to is the command, in the job's log.
    const detail = await api.ci.getRun({
      params: { owner: "acme", repo: "infra", runId: run.id },
    });
    const lint = detail.jobs!.find((job) => job.pipeline === "terraform" && job.id === "lint")!;
    expect(lint.stdout.split("\n")[5]).toMatch(/^::should-fix file=modules\/network\/main\.tf,/);
    expect(lint.stdout.split("\n")[6]).toMatch(
      /^::doubt file=modules\/network\/main\.tf,line=176::/,
    );
  });

  it("opens the file an address names", async () => {
    serve();
    open(`${WHOLE}#diff-docs%2Fpeering.md`);
    expect(await screen.findByRole("button", { name: "Hide docs/peering.md" }, wait)).toBeTruthy();
    expect(screen.getByRole("button", { name: `Show ${MAIN}` })).toBeTruthy();
  });

  it("decides whether an entry needs its code when the writer does not say", async () => {
    serve();
    const params = { owner: "acme", repo: "infra" };
    const recorded = await api.traces.record({
      params,
      payload: {
        branch: "feature/vpc-peering",
        entries: [
          { kind: "decision", body: "On a line.", anchors: [{ path: MAIN, startLine: 120 }] },
          { kind: "decision", body: "On a file.", anchors: [{ path: MAIN }] },
          { kind: "doubt", body: "On nothing." },
          {
            kind: "doubt",
            body: "On a line, said not to need it.",
            needsCode: false,
            anchors: [{ path: MAIN, startLine: 120 }],
          },
          { kind: "note", body: "Said to need it, with nothing to show.", needsCode: true },
        ],
      },
    });
    expect(recorded.entries.map((entry) => entry.needsCode)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
