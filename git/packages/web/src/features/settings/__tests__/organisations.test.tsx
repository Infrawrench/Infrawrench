/**
 * Settings > Organisations against the dev mock, through the real router:
 * what each organisation shows, the name form's refusals, and a claim.
 *
 * The mock's state is the module's, so the claim that succeeds is last.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NAMESPACE_PLAN_REQUIRED } from "@infrawrench/git-contract";
import { ApiError, setTransport, type Transport } from "../../../api/client";
import { queryClient } from "../../../api/queries";
import { setScenario } from "../../../mock/db";
import { routeTree } from "../../../routeTree.gen";

/** Answers the next claim with this instead of the mock's. */
let refuseClaim: ApiError | null = null;

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
    if (key === "namespaces.claimForOrganization" && refuseClaim !== null) {
      const refusal = refuseClaim;
      refuseClaim = null;
      throw refusal;
    }
    const handler = table.get(key);
    if (handler === undefined) throw new ApiError(501, `No mock handler for ${key}`);
    const answer = await handler(request);
    return answer === undefined ? undefined : structuredClone(answer);
  };
}

const wait = { timeout: 10_000 };
vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
  window.scrollTo = () => {};
  setTransport(mockTransport());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  setScenario("signed-in");
  refuseClaim = null;
});

async function open() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/settings/organisations"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return within(await screen.findByRole("list", { name: "Organisations" }, wait));
}

const rowOf = (list: ReturnType<typeof within>, name: string) =>
  within(list.getByText(name).closest("li")!);

const nameField = (row: ReturnType<typeof within>) =>
  row.getByRole("textbox", { name: "Name for Northwind Labs" }) as HTMLInputElement;

describe("Settings > Organisations", () => {
  it("shows each organisation's name here, or who can give it one", async () => {
    const list = await open();
    expect(list.getAllByRole("listitem")).toHaveLength(6);

    const acme = rowOf(list, "Acme");
    expect(acme.getByRole("link", { name: "git.infrawrench.com/acme" }).getAttribute("href")).toBe(
      "/acme",
    );
    expect(acme.getByRole("link", { name: "Create a repository" }).getAttribute("href")).toBe(
      "/new?owner=acme",
    );
    expect(acme.queryByRole("textbox")).toBeNull();

    // Not an administrator there: nothing to fill in.
    const harbour = rowOf(list, "Harbour Works");
    expect(
      harbour.getByText("Ask an administrator of Harbour Works to claim its name"),
    ).toBeTruthy();
    expect(harbour.queryByRole("textbox")).toBeNull();
    expect(harbour.queryByRole("button")).toBeNull();

    // An administrator, but the organisation has no Git.
    const lowland = rowOf(list, "Lowland Freight");
    expect(lowland.getByText("Git is not on for Lowland Freight")).toBeTruthy();
    expect(lowland.queryByRole("textbox")).toBeNull();

    // An administrator of an organisation on the free plan: the plan's
    // sentence, and the way to its billing page in the app.
    const saltmarsh = rowOf(list, "Saltmarsh Studio");
    expect(
      saltmarsh.getByText(/Organisations on git\.infrawrench\.com need a paid plan/),
    ).toBeTruthy();
    expect(saltmarsh.getByRole("link", { name: "Open billing" }).getAttribute("href")).toBe(
      "https://app.infrawrench.com/org/org_saltmarsh/settings/billing",
    );
    expect(saltmarsh.queryByRole("textbox")).toBeNull();

    // The one to claim starts from the organisation's own name.
    const northwind = rowOf(list, "Northwind Labs");
    expect(nameField(northwind).value).toBe("northwind-labs");
    expect(await northwind.findByText("Available", undefined, wait)).toBeTruthy();
  });

  it("is in the settings navigation", async () => {
    await open();
    const nav = within(screen.getByRole("navigation", { name: "Settings" }));
    const link = nav.getByRole("link", { name: "Organisations" });
    expect(link.getAttribute("href")).toBe("/settings/organisations");
    expect(link.getAttribute("aria-current")).toBe("page");
    // And, while there is a name to claim, in the workspace switcher.
    fireEvent.click(screen.getByRole("button", { name: /^Workspace: / }));
    expect(
      (await screen.findByRole("menuitem", { name: "Add an organisation" }, wait)).getAttribute(
        "href",
      ),
    ).toBe("/settings/organisations");
  });

  it("refuses a name the rules do not allow before it is sent", async () => {
    const northwind = rowOf(await open(), "Northwind Labs");
    const claim = northwind.getByRole("button", { name: "Claim" }) as HTMLButtonElement;

    fireEvent.change(nameField(northwind), { target: { value: "-nope" } });
    expect(northwind.getByRole("alert").textContent).toMatch(/start with a letter/i);
    expect(claim.disabled).toBe(true);

    fireEvent.change(nameField(northwind), { target: { value: "explore" } });
    expect(northwind.getByRole("alert").textContent).toMatch(/reserved/i);
    expect(claim.disabled).toBe(true);
  });

  it("says a name is taken as it is typed, and when the server says so", async () => {
    const northwind = rowOf(await open(), "Northwind Labs");
    fireEvent.change(nameField(northwind), { target: { value: "acme" } });
    await waitFor(
      () => expect(northwind.getByRole("alert").textContent).toBe("That name is taken"),
      wait,
    );
    expect((northwind.getByRole("button", { name: "Claim" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    // Sent before the check came back: the answer lands under the field.
    fireEvent.change(nameField(northwind), { target: { value: "Tidewater" } });
    fireEvent.submit(nameField(northwind).closest("form")!);
    await waitFor(
      () => expect(northwind.getByRole("alert").textContent).toBe("That name is taken"),
      wait,
    );
    expect(nameField(northwind).value).toBe("Tidewater");
  });

  it("shows why when the server refuses someone who is not an administrator", async () => {
    const northwind = rowOf(await open(), "Northwind Labs");
    await northwind.findByText("Available", undefined, wait);
    refuseClaim = new ApiError(403, "This needs git:admin in the organisation");
    fireEvent.click(northwind.getByRole("button", { name: "Claim" }));
    await waitFor(
      () =>
        expect(northwind.getByRole("alert").textContent).toBe(
          "This needs git:admin in the organisation",
        ),
      wait,
    );
    // Nothing was claimed: the form is still there.
    expect(nameField(northwind).value).toBe("northwind-labs");
  });

  it("shows the plan's refusal when the server gives it", async () => {
    const northwind = rowOf(await open(), "Northwind Labs");
    await northwind.findByText("Available", undefined, wait);
    refuseClaim = new ApiError(402, NAMESPACE_PLAN_REQUIRED, "plan_required");
    fireEvent.click(northwind.getByRole("button", { name: "Claim" }));
    await waitFor(
      () => expect(northwind.getByRole("alert").textContent).toBe(NAMESPACE_PLAN_REQUIRED),
      wait,
    );
  });

  it("claims the name, and the organisation is then a place for repositories", async () => {
    const list = await open();
    const northwind = rowOf(list, "Northwind Labs");
    fireEvent.change(nameField(northwind), { target: { value: "northwind" } });
    await northwind.findByText("Available", undefined, wait);
    fireEvent.click(northwind.getByRole("button", { name: "Claim" }));

    const link = await list.findByRole("link", { name: "git.infrawrench.com/northwind" }, wait);
    expect(link.getAttribute("href")).toBe("/northwind");
    const claimed = rowOf(list, "Northwind Labs");
    expect(claimed.queryByRole("textbox")).toBeNull();
    expect(claimed.getByRole("link", { name: "Create a repository" }).getAttribute("href")).toBe(
      "/new?owner=northwind",
    );
    // The sidebar's workspaces are read from the same session, and with
    // nothing left to claim the switcher stops offering this page.
    fireEvent.click(screen.getByRole("button", { name: /^Workspace: / }));
    expect(await screen.findByRole("menuitemradio", { name: "Northwind Labs" }, wait)).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Add an organisation" })).toBeNull();
  });
});
