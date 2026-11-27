/**
 * CI where it does not run, against the dev mock through the real router: a
 * repository whose organisation is on the free plan says Infrawrench CI is
 * part of Pro and links to billing in the app, on its CI tab, in Settings >
 * CI and where a branch page would have listed runs; someone who is not a
 * member gets the sentence without the link; and a personal namespace that
 * runs in no organisation is pointed at Settings > Profile.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, api, setTransport, type ApiCall, type Transport } from "../../../api/client";
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
  window.scrollTo = () => {};
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

/** Every call goes to the mock, unless `answers` has one for its `group.endpoint`. */
function serve(answers: Record<string, (call: ApiCall) => unknown> = {}) {
  setTransport(async (call: ApiCall) => {
    const answer = answers[`${call.group}.${call.endpoint}`];
    return answer === undefined ? mock(call) : answer(call);
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
  serve();
});

const wait = { timeout: 5000 };
const SENTENCE = "Infrawrench CI is part of Pro";
const BILLING = "https://app.infrawrench.com/org/org_tidewater/settings/billing";

describe("CI for an organisation on the free plan", () => {
  it("answers the plan as the reason, with billing in the app for a member", async () => {
    serve();
    const status = await api.ci.status({ params: { owner: "tidewater", repo: "ledger" } });
    expect(status).toMatchObject({
      enabled: false,
      code: "plan_required",
      reason: SENTENCE,
      upgradeUrl: BILLING,
    });
    // A paid organisation's repository is not blocked, and names no billing page.
    expect(await api.ci.status({ params: { owner: "acme", repo: "infra" } })).toMatchObject({
      enabled: true,
      code: null,
      upgradeUrl: null,
    });
  });

  it("refuses switching CI on with the plan, and still lets it be switched off", async () => {
    serve();
    const params = { owner: "tidewater", repo: "ledger" };
    await expect(
      api.ci.updateSettings({ params, payload: { enabled: false } }),
    ).resolves.toMatchObject({ enabled: false });
    await expect(
      api.ci.updateSettings({ params, payload: { enabled: true } }),
    ).rejects.toMatchObject({ status: 402, code: "plan_required", message: SENTENCE });
  });

  it("says so on the CI tab, with an Upgrade link out to the app's billing", async () => {
    serve();
    open("/tidewater/ledger/ci");
    expect(await screen.findByText(SENTENCE, {}, wait)).toBeTruthy();
    const upgrade = screen.getByRole("link", { name: /Upgrade to Pro/ });
    expect(upgrade.getAttribute("href")).toBe(BILLING);
    // The forge links out; it never embeds the app.
    expect(upgrade.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("list", { name: "Runs" })).toBeNull();
  });

  it("says who can upgrade, with no link, to someone outside the organisation", async () => {
    serve({
      "ci.status": async (call) => ({
        ...((await mock(call)) as Record<string, unknown>),
        upgradeUrl: null,
      }),
    });
    open("/tidewater/ledger/ci");
    expect(await screen.findByText(SENTENCE, {}, wait)).toBeTruthy();
    expect(
      screen.getByText("Someone who manages billing in its organisation can upgrade"),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Upgrade to Pro/ })).toBeNull();
  });

  it("says so in Settings > CI, where nothing can be switched on", async () => {
    serve();
    open("/tidewater/ledger/settings/ci");
    expect(await screen.findByText(SENTENCE, {}, wait)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Upgrade to Pro/ }).getAttribute("href")).toBe(BILLING);
    expect(screen.getByRole("status").textContent).toBe("Off");
    expect(screen.queryByRole("button", { name: "Switch on" })).toBeNull();
  });

  it("says so on a branch page's Checks tab when its pipelines would have run", async () => {
    serve({
      "ci.status": async (call) => ({
        ...((await mock(call)) as Record<string, unknown>),
        enabled: false,
        code: "plan_required",
        reason: SENTENCE,
        upgradeUrl: BILLING,
      }),
      "ci.listRuns": async () => ({ items: [], nextCursor: null }),
    });
    open("/acme/infra/branches/feature/vpc-peering?tab=checks");
    expect(await screen.findByText(SENTENCE, {}, wait)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Upgrade to Pro/ }).getAttribute("href")).toBe(BILLING);
    expect(screen.queryByText("No runs for this commit")).toBeNull();
  });

  it("leaves the Checks tab alone for a repository with a plan", async () => {
    serve({ "ci.listRuns": async () => ({ items: [], nextCursor: null }) });
    open("/acme/infra/branches/feature/vpc-peering?tab=checks");
    expect(await screen.findByText("No runs for this commit", {}, wait)).toBeTruthy();
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});

describe("CI for a personal namespace that runs in no organisation", () => {
  it("points its owner at Settings > Profile", async () => {
    serve();
    open("/mara/route-lab/ci");
    const sentence = await screen.findByText(
      "CI runs in an organisation. Choose one for your own repositories in Settings > Profile",
      {},
      wait,
    );
    const choose = within(sentence.parentElement!).getByRole("link", {
      name: "Choose an organisation",
    });
    expect(choose.getAttribute("href")).toBe("/settings");
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});
