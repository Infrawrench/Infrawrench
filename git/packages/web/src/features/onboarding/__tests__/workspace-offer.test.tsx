/**
 * Setting up a workspace, against the dev mock and through the real router:
 * who is offered one on the username page and in Settings > Organisations,
 * what the page sends, and what it does when the browser comes back from the
 * payment page, paid or not.
 *
 * The mock has no payment page: its `startWorkspaceCheckout` creates the
 * organisation at once and answers the page the app would send the browser
 * back to, so following it is the whole trip.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, setTransport, type Transport } from "../../../api/client";
import { queryClient } from "../../../api/queries";
import { session, setScenario } from "../../../mock/db";
import { routeTree } from "../../../routeTree.gen";

/** What the page sent, by endpoint. */
const sent: Array<{ key: string; request: any }> = [];

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
    const key = `${group}.${endpoint}`;
    sent.push({ key, request });
    const handler = table.get(key);
    if (handler === undefined) throw new ApiError(501, `No mock handler for ${key}`);
    const answer = await handler(request);
    return answer === undefined ? undefined : structuredClone(answer);
  };
}

const wait = { timeout: 10_000 };
vi.setConfig({ testTimeout: 20_000 });

const OFFER = "Set up a workspace";
const LINE = "CI and review agents run in it. Pro, $20 a month.";
const PAY = "Continue to payment ($20 a month)";
const RUNS_IN = "Run CI and review agents in";

beforeAll(() => {
  window.scrollTo = () => {};
  setTransport(mockTransport());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  sessionStorage.removeItem("git-workspace-name");
  setScenario("signed-in");
  sent.length = 0;
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

const calls = (key: string) => sent.filter((call) => call.key === key).map((call) => call.request);
const nameField = () => screen.getByLabelText("Organisation name") as HTMLInputElement;

describe("the username page, for someone in no organisation", () => {
  it("offers a workspace in place of the organisation choice, with its price and one line", async () => {
    setScenario("new-solo");
    open("/onboarding/username");
    await screen.findByRole("heading", { name: OFFER }, wait);
    expect(screen.getByText(LINE)).toBeTruthy();
    // Named after them, to change or keep.
    expect(nameField().value).toBe("Mara Lindqvist's workspace");
    // Nothing to choose from, so nothing asks.
    expect(screen.queryByLabelText(RUNS_IN)).toBeNull();
    expect(screen.getByRole("button", { name: PAY })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("goes on with no organisation on Not now", async () => {
    setScenario("new-solo");
    open("/onboarding/username");
    await screen.findByText("Available", undefined, wait);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(session().user?.username).toBe("mara-lindqvist"), wait);
    expect(calls("session.claimUsername")).toEqual([
      { payload: { username: "mara-lindqvist", workspaceOrganizationId: null } },
    ]);
    expect(calls("session.startWorkspaceCheckout")).toEqual([]);
    expect(session().organizations).toEqual([]);
    expect(session().personal?.workspace).toBeNull();
  });

  it("needs a name before it goes to the payment page, and refuses one that is too long", async () => {
    setScenario("new-solo");
    open("/onboarding/username");
    await screen.findByText("Available", undefined, wait);
    const pay = screen.getByRole("button", { name: PAY }) as HTMLButtonElement;
    expect(pay.disabled).toBe(false);
    fireEvent.change(nameField(), { target: { value: "   " } });
    expect(pay.disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: "a".repeat(101) } });
    expect(screen.getByText("The name can be 100 characters at most")).toBeTruthy();
    expect(pay.disabled).toBe(true);
    // Not now never depends on it.
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.submit(nameField().closest("form")!);
    expect(calls("session.startWorkspaceCheckout")).toEqual([]);
  });

  it("sends the name and the username chosen, and finishes when the browser comes back", async () => {
    setScenario("new-solo");
    const router = open("/onboarding/username?returnTo=%2Fnew");
    const username = (await screen.findByLabelText(
      "Username",
      undefined,
      wait,
    )) as HTMLInputElement;
    fireEvent.change(username, { target: { value: "mara-chosen" } });
    await screen.findByText("Available", undefined, wait);
    fireEvent.change(nameField(), { target: { value: " Lindqvist Labs " } });
    fireEvent.click(screen.getByRole("button", { name: PAY }));

    // Back from "paying": the organisation is theirs, and the page goes on by itself.
    await waitFor(() => expect(session().user?.username).toBe("mara-chosen"), wait);
    expect(calls("session.startWorkspaceCheckout")).toEqual([
      {
        payload: {
          name: "Lindqvist Labs",
          from: "onboarding",
          username: "mara-chosen",
          returnTo: "/new",
        },
      },
    ]);
    const [organization] = session().organizations;
    expect(organization).toMatchObject({ name: "Lindqvist Labs", paid: true });
    expect(calls("session.claimUsername")).toEqual([
      { payload: { username: "mara-chosen", workspaceOrganizationId: organization!.id } },
    ]);
    expect(session().personal?.workspace).toEqual({ id: organization!.id, name: "Lindqvist Labs" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"), wait);
  });

  it("waits for the person when the username they chose is one that is paid for", async () => {
    setScenario("new-solo");
    open("/onboarding/username");
    const username = (await screen.findByLabelText(
      "Username",
      undefined,
      wait,
    )) as HTMLInputElement;
    fireEvent.change(username, { target: { value: "maral6" } });
    await screen.findByText("$50, paid once", undefined, wait);
    fireEvent.click(screen.getByRole("button", { name: PAY }));

    // The workspace is theirs and chosen; the username is still theirs to pay for.
    const select = (await screen.findByLabelText(RUNS_IN, undefined, wait)) as HTMLSelectElement;
    const [organization] = session().organizations;
    await waitFor(() => expect(select.value).toBe(organization!.id), wait);
    expect(screen.getByRole("button", { name: "Continue to payment ($50)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: OFFER })).toBeNull();
    expect(calls("session.claimUsername")).toEqual([]);
    expect(session().user?.username).toBeNull();
  });

  it("keeps the name and the username for someone who comes back without paying", async () => {
    setScenario("new-solo");
    sessionStorage.setItem("git-workspace-name", "Lindqvist Labs");
    open("/onboarding/username?username=mara-chosen&workspace=cancelled");
    await screen.findByRole("heading", { name: OFFER }, wait);
    expect(nameField().value).toBe("Lindqvist Labs");
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("mara-chosen");
    // Leaving the payment page needs no words, and nothing is claimed for them.
    expect(screen.queryByRole("status")).toBeNull();
    await screen.findByText("Available", undefined, wait);
    expect(calls("session.claimUsername")).toEqual([]);
    expect(calls("session.startWorkspaceCheckout")).toEqual([]);
    expect(session().organizations).toEqual([]);
  });

  it("says so when there was no payment page to show", async () => {
    setScenario("new-solo");
    open("/onboarding/username?workspace=unavailable");
    expect((await screen.findByRole("status", undefined, wait)).textContent).toBe(
      "Payments are not available right now. Nothing was charged.",
    );
    cleanup();
    queryClient.clear();
    open("/onboarding/username?workspace=expired");
    expect((await screen.findByRole("status", undefined, wait)).textContent).toBe(
      "The payment page expired before it was opened. Nothing was charged.",
    );
    expect(calls("session.claimUsername")).toEqual([]);
  });

  it("is not offered to someone who belongs to an organisation", async () => {
    setScenario("new-user");
    open("/onboarding/username");
    await screen.findByLabelText(RUNS_IN, undefined, wait);
    expect(screen.queryByRole("heading", { name: OFFER })).toBeNull();
    expect(screen.queryByLabelText("Organisation name")).toBeNull();
    expect(screen.queryByRole("button", { name: PAY })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    // And never finishes by itself on a link that says it should.
    cleanup();
    queryClient.clear();
    open("/onboarding/username?username=mara-chosen&workspace=return");
    await screen.findByLabelText(RUNS_IN, undefined, wait);
    await screen.findByText("Available", undefined, wait);
    expect(calls("session.claimUsername")).toEqual([]);
  });
});

describe("Settings > Organisations, for someone in no organisation", () => {
  it("offers a workspace, and shows the organisation once it is paid for", async () => {
    setScenario("solo");
    open("/settings/organisations");
    await screen.findByRole("heading", { name: OFFER }, wait);
    expect(screen.getByText("You are not in an organisation")).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(nameField().value).toBe("Mara Lindqvist's workspace");
    fireEvent.change(nameField(), { target: { value: "Lindqvist Labs" } });
    fireEvent.click(screen.getByRole("button", { name: PAY }));

    const list = within(await screen.findByRole("list", { name: "Organisations" }, wait));
    expect(list.getByText("Lindqvist Labs")).toBeTruthy();
    expect(calls("session.startWorkspaceCheckout")).toEqual([
      { payload: { name: "Lindqvist Labs", from: "settings" } },
    ]);
    expect(screen.queryByRole("heading", { name: OFFER })).toBeNull();
    // Their own repositories run in it from here.
    expect(session().personal?.workspace).toMatchObject({ name: "Lindqvist Labs" });
  });

  it("is not offered to someone who belongs to an organisation", async () => {
    setScenario("signed-in");
    open("/settings/organisations");
    await screen.findByRole("list", { name: "Organisations" }, wait);
    expect(screen.queryByRole("heading", { name: OFFER })).toBeNull();
    expect(screen.queryByRole("button", { name: PAY })).toBeNull();
  });
});
