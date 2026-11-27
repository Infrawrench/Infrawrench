/**
 * Settings > Profile's commit emails against the dev mock, through the real
 * router: the reader's addresses for their own repositories, apart from the
 * ones each organisation keeps on Settings > Organisations.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, setTransport, type Transport } from "../../../api/client";
import { queryClient } from "../../../api/queries";
import { setScenario } from "../../../mock/db";
import { routeTree } from "../../../routeTree.gen";

/** What the page sent, as `group.endpoint` and its request. */
const sent: Array<[string, unknown]> = [];

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
    sent.push([key, request]);
    const handler = table.get(key);
    if (handler === undefined) throw new ApiError(501, `No mock handler for ${key}`);
    const answer = await handler(request);
    return answer === undefined ? undefined : structuredClone(answer);
  };
}

const wait = { timeout: 10_000 };
vi.setConfig({ testTimeout: 20_000 });
const TITLE = "Commit emails in your own repositories";

beforeAll(() => {
  window.scrollTo = () => {};
  setTransport(mockTransport());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  setScenario("signed-in");
  sent.length = 0;
});

async function open(path = "/settings") {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const section = async () => within(await screen.findByRole("region", { name: TITLE }, wait));

describe("Settings > Profile: commit emails", () => {
  it("lists the reader's own addresses, and none of an organisation's", async () => {
    await open();
    expect(await screen.findByRole("heading", { name: "Commit emails" }, wait)).toBeTruthy();
    const own = await section();
    const [verified, pending] = within(own.getByRole("list", { name: TITLE })).getAllByRole(
      "listitem",
    );
    expect(verified!.textContent).toContain("mara@laptop.example");
    expect(within(verified!).getByText("Verified")).toBeTruthy();
    expect(within(verified!).queryByRole("textbox")).toBeNull();
    expect(pending!.textContent).toContain("mara@studio.example");
    expect(within(pending!).getByText("Pending")).toBeTruthy();
    expect(
      within(pending!).getByRole("textbox", { name: "Code sent to mara@studio.example" }),
    ).toBeTruthy();
    expect(within(pending!).getByRole("button", { name: "Send again" })).toBeTruthy();
    // Acme's are on Settings > Organisations.
    expect(own.queryByText("mara@lindqvist.example")).toBeNull();
    expect(own.queryByText("mara.lindqvist@harbour.example")).toBeNull();
    expect(
      own.getByRole("textbox", { name: "Add an address for your own repositories" }),
    ).toBeTruthy();
  });

  it("keeps the reader's own addresses off Settings > Organisations", async () => {
    await open("/settings/organisations");
    const acme = within(await screen.findByRole("region", { name: "Commit emails in Acme" }, wait));
    expect(acme.getByText("mara@lindqvist.example")).toBeTruthy();
    expect(screen.queryByText("mara@laptop.example")).toBeNull();
    expect(screen.queryByText("mara@studio.example")).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("verifies a pending address with its code, and says when the code is wrong", async () => {
    await open();
    const own = await section();
    const field = () => own.getByRole("textbox", { name: "Code sent to mara@studio.example" });
    fireEvent.change(field(), { target: { value: "WXYZ-9999" } });
    fireEvent.click(own.getByRole("button", { name: "Verify" }));
    expect((await own.findByRole("alert", undefined, wait)).textContent).toBe(
      "That code is not right",
    );
    fireEvent.change(field(), { target: { value: "abcd2345" } });
    fireEvent.click(own.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(own.getAllByText("Verified")).toHaveLength(2), wait);
    expect(own.queryByText("Pending")).toBeNull();
  });

  it("adds an address under no organisation, refuses the ones it must, and removes one", async () => {
    await open();
    const own = await section();
    const input = own.getByRole("textbox", { name: "Add an address for your own repositories" });
    const addButton = own.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    // Someone else's account address, the reader's own, and a bot's.
    fireEvent.change(input, { target: { value: "jonas@acme.example" } });
    fireEvent.click(addButton);
    expect(
      await own.findByText("That address is on another person's account", undefined, wait),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "mara@acme.example" } });
    fireEvent.click(addButton);
    expect(
      await own.findByText("That is the address on your account already", undefined, wait),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "cursoragent@cursor.com" } });
    fireEvent.click(addButton);
    expect(
      await own.findByText("That address belongs to a bot account", undefined, wait),
    ).toBeTruthy();

    // One Acme already has is still free here: the two are counted apart.
    fireEvent.change(input, { target: { value: "Mara@Lindqvist.Example" } });
    fireEvent.click(addButton);
    expect(
      await own.findByRole("textbox", { name: "Code sent to mara@lindqvist.example" }, wait),
    ).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    const added = sent.filter(([key]) => key === "account.addCommitEmail").at(-1)![1];
    expect(added).toEqual({
      payload: { organizationId: null, email: "Mara@Lindqvist.Example" },
    });

    fireEvent.click(own.getByRole("button", { name: "Remove mara@lindqvist.example" }));
    await waitFor(() => expect(own.queryByText("mara@lindqvist.example")).toBeNull(), wait);
    // Acme's row with that address is untouched.
    cleanup();
    queryClient.clear();
    await open("/settings/organisations");
    const acme = within(await screen.findByRole("region", { name: "Commit emails in Acme" }, wait));
    expect(acme.getByText("mara@lindqvist.example")).toBeTruthy();
  });
});
