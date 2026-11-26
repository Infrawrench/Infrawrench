/**
 * The review pages against the dev mock, through the real router: the branch
 * page and its modes, the version rail, dismissing a finding, switching to
 * classic and back, starting work, the inbox, and a server that does not
 * serve traces, findings and instructions yet.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, api, setTransport, type Transport } from "../../../api/client";
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
});

/** Every call goes to the mock, unless `refuse` names its group: a server that does not serve it yet. */
function serve(refuse: ReadonlyArray<string> = []) {
  setTransport((call) =>
    refuse.includes(call.group)
      ? Promise.reject(new ApiError(503, "Not available yet", "not_implemented"))
      : mock(call),
  );
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

afterEach(async () => {
  cleanup();
  queryClient.clear();
  // Each test starts in the default mode.
  serve();
  await api.review.setMode({ payload: { mode: "agent" } });
});

const wait = { timeout: 5000 };

describe("classic mode", () => {
  it("is the pull request as it was, one switch away and back", async () => {
    serve();
    open("/acme/infra/pulls/12");
    await screen.findByRole("navigation", { name: "Versions" }, wait);
    const group = screen.getByRole("group", { name: "Open pull requests as" });
    fireEvent.click(within(group).getByRole("button", { name: "Classic" }));
    expect(await screen.findByRole("link", { name: /Files changed/ }, wait)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Conversation/ })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Versions" })).toBeNull();
    expect((await api.review.mode()).mode).toBe("classic");

    fireEvent.click(
      within(screen.getByRole("group", { name: "Open pull requests as" })).getByRole("button", {
        name: "Branch page",
      }),
    );
    expect(await screen.findByRole("navigation", { name: "Versions" }, wait)).toBeTruthy();
  });

  it("keeps the home page without the inbox, which agent mode has", async () => {
    serve();
    await api.review.setMode({ payload: { mode: "classic" } });
    open("/");
    expect(await screen.findByRole("heading", { name: "Recent pushes" }, wait)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Waiting on you" })).toBeNull();
    cleanup();
    queryClient.clear();

    await api.review.setMode({ payload: { mode: "agent" } });
    open("/");
    const list = await screen.findByRole("list", { name: "Branches waiting on you" }, wait);
    const first = within(list).getAllByRole("listitem")[0]!;
    expect(first.textContent).toContain("Peer with the shared services VPC");
    expect(first.textContent).toContain("1 must fix");
    expect(
      within(first)
        .getByRole("link", { name: /Peer with/ })
        .getAttribute("href"),
    ).toMatch(/^\/acme\/infra\/pulls\/12\?v=\d+&diff=since$/);
  });
});

describe("the branch page", () => {
  it("replaces the pull request for someone in agent mode: the rail, the ask, the trace, the merge block", async () => {
    serve();
    open("/acme/infra/pulls/12");
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
    expect(screen.getByRole("link", { name: /Review/ }).getAttribute("href")).toBe(
      "/acme/infra/pulls/12",
    );
    expect(screen.queryByRole("link", { name: /Files changed/ })).toBeNull();
    // It opens on what changed since v2, with v3's trace above its lines.
    expect(await screen.findByText("v2 to v3", { exact: false }, wait)).toBeTruthy();
    expect(await screen.findByText("and the diagram redrawn", { exact: false }, wait)).toBeTruthy();
    // The merge box holds on the must-fix finding and offers an administrator the override.
    const merge = screen.getByRole("region", { name: "Merge" });
    expect(within(merge).getByText("1 must-fix finding open")).toBeTruthy();
    expect(within(merge).getByRole("button", { name: "Override" })).toBeTruthy();
    expect(within(merge).queryByRole("button", { name: /Merge pull request/ })).toBeNull();
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
    const router = open("/acme/infra/pulls/12?v=2&diff=step");
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
    const list = await api.versions.list({ params: { owner: "acme", repo: "infra", number: 12 } });
    expect(list.viewerReviewed).toBe(3);
  });

  it("dismisses a finding with a reason, and reopens it", async () => {
    serve();
    open("/acme/infra/pulls/12?v=3&diff=whole");
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
    open("/acme/infra/pulls/12?v=3&diff=whole");
    expect(await screen.findByRole("navigation", { name: "Versions" }, wait)).toBeTruthy();
    expect(await screen.findByText("v3 against its base", { exact: false }, wait)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Findings" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Instructions" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "Merge" })).toBeTruthy();
  });
});

describe("start work", () => {
  it("names the branch from the ask, offers the agents, and goes to the new branch's page", async () => {
    serve();
    const router = open("/acme/infra/pulls/start");
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
      () => expect(router.state.location.pathname).toMatch(/^\/acme\/infra\/pulls\/\d+$/),
      wait,
    );
    expect(
      await screen.findByText("The agent is working on v1", { exact: false }, wait),
    ).toBeTruthy();
    const number = Number(router.state.location.pathname.split("/").pop());
    const made = await api.pulls.get({ params: { owner: "acme", repo: "infra", number } });
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
