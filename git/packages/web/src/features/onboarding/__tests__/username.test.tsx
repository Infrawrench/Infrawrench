/**
 * The first sign-in's page and Settings > Profile against the dev mock,
 * through the real router: the username, the organisation the person's own
 * repositories run CI and review agents in, and changing that later.
 *
 * The mock's state is the module's, so the tests run in order: someone new
 * claims a username, then changes where they run.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const LABEL = "Run CI and review agents in";

beforeAll(() => {
  window.scrollTo = () => {};
  setTransport(mockTransport());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
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

const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((option) => option.textContent);

describe("choosing a username", () => {
  it("asks where the person's own repositories run, and takes None for an answer", async () => {
    setScenario("new-user");
    open("/onboarding/username");
    const select = (await screen.findByLabelText(LABEL, undefined, wait)) as HTMLSelectElement;
    // Every organisation of theirs, then None; several can run CI, so nothing is chosen for them.
    expect(optionsOf(select)).toEqual([
      "Choose an organisation",
      ...session().organizations.map((organization) => organization.name),
      "None",
    ]);
    expect(select.value).toBe("");
    const submit = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    await screen.findByText("Available", undefined, wait);
    expect(submit.disabled).toBe(true);

    // One that cannot run CI yet says so, and can still be chosen.
    fireEvent.change(select, { target: { value: "org_saltmarsh" } });
    expect(screen.getByText("CI needs a paid plan there")).toBeTruthy();
    fireEvent.change(select, { target: { value: "org_acme" } });
    expect(screen.queryByText("CI needs a paid plan there")).toBeNull();
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(session().user?.username).toBe("mara-lindqvist"), wait);
    expect(sent.find((call) => call.key === "session.claimUsername")?.request).toEqual({
      payload: { username: "mara-lindqvist", workspaceOrganizationId: "org_acme" },
    });
    expect(session().personal?.workspace).toEqual({ id: "org_acme", name: "Acme" });
  });

  it("claims a username of seven characters without a payment", async () => {
    setScenario("new-user");
    open("/onboarding/username");
    const input = (await screen.findByLabelText("Username", undefined, wait)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "maralin" } });
    await screen.findByText("Available", undefined, wait);
    expect(screen.queryByText("$50, paid once")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /payment/ })).toBeNull();
  });

  it("shows the price of a username of six characters or fewer, and sends it to the payment page", async () => {
    setScenario("new-user");
    open("/onboarding/username?returnTo=%2Facme%2Finfra");
    const input = (await screen.findByLabelText("Username", undefined, wait)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "maral6" } });
    await screen.findByText("Available", undefined, wait);
    expect(screen.getByText("$50, paid once")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const pay = screen.getByRole("button", {
      name: "Continue to payment ($50)",
    }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: "org_acme" } });
    expect(pay.disabled).toBe(false);

    fireEvent.click(pay);
    // The mock has no payment page: the name is theirs when they come back.
    await screen.findByText("Your username is maral6", undefined, wait);
    expect(sent.some((call) => call.key === "session.claimUsername")).toBe(false);
    expect(sent.find((call) => call.key === "session.startUsernameCheckout")?.request).toEqual({
      payload: { username: "maral6", workspaceOrganizationId: "org_acme", returnTo: "/acme/infra" },
    });
    expect(session().personal?.workspace).toEqual({ id: "org_acme", name: "Acme" });
  });
});

describe("Settings > Profile", () => {
  it("charges for a change to a short username, and not for a long one", async () => {
    setScenario("signed-in");
    open("/settings");
    const input = (await screen.findByLabelText("Username", undefined, wait)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mara-the-long" } });
    await screen.findByText("Available", undefined, wait);
    expect(screen.getByRole("button", { name: "Change username" })).toBeTruthy();
    expect(screen.queryByText("$50, paid once")).toBeNull();

    fireEvent.change(input, { target: { value: "mar" } });
    await screen.findByText("$50, paid once", undefined, wait);
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment ($50)" }));
    await waitFor(() => expect(session().user?.username).toBe("mar"), wait);
    expect(sent.some((call) => call.key === "session.renameUsername")).toBe(false);
  });

  it("shows where the person's repositories run and changes it as it is chosen", async () => {
    setScenario("signed-in");
    open("/settings");
    const select = (await screen.findByLabelText(LABEL, undefined, wait)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("org_acme"), wait);
    expect(optionsOf(select)).toEqual([
      ...session().organizations.map((organization) => organization.name),
      "None",
    ]);

    fireEvent.change(select, { target: { value: "none" } });
    await waitFor(() => expect(session().personal?.workspace).toBeNull(), wait);
    expect(sent.find((call) => call.key === "session.setWorkspace")?.request).toEqual({
      payload: { organizationId: null },
    });
    await waitFor(
      () => expect((screen.getByLabelText(LABEL) as HTMLSelectElement).value).toBe("none"),
      wait,
    );

    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: "org_tidewater" } });
    await waitFor(
      () =>
        expect(session().personal?.workspace).toEqual({ id: "org_tidewater", name: "Tidewater" }),
      wait,
    );
  });
});
