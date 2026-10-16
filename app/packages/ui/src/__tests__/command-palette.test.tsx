import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { SEARCH_RESULT_KINDS, type SearchResult, type StarredItem } from "@infrawrench/client-core";
import { CommandPalette } from "../command-palette/CommandPalette.js";
import {
  PaletteHostProvider,
  useStarredStore,
  type PaletteClient,
  type PaletteHostValue,
} from "../command-palette/host.js";
import {
  clearPaletteIntents,
  requestPaletteIntent,
  usePaletteIntent,
  PALETTE_INTENT_TTL_MS,
} from "../command-palette/intents.js";
import { paletteDestination, starRefFromTarget } from "../command-palette/kinds.js";
import { MAX_RECENTS, pushRecent, useRecentsStore } from "../command-palette/recents.js";
import type { PaletteAction } from "../command-palette/actions.js";
import { getWorkspaceTabId } from "../store/ui.store.js";

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

function hit(kind: SearchResult["kind"], id: string, name: string, extra?: Partial<SearchResult>) {
  return {
    id,
    kind,
    pluginId: kind === "resource" ? "aws" : "__objects__",
    pluginDisplayName: "",
    pluginLogoSvg: "",
    resourceTypeId: kind === "resource" ? "ec2" : (kind as string),
    resourceTypeLabel: "",
    accountId: kind === "resource" ? "acc-1" : "",
    accountName: "",
    displayName: name,
    ...extra,
  } satisfies SearchResult;
}

function starred(kind: StarredItem["kind"], id: string, name: string): StarredItem {
  return { ...hit(kind, id, name), kind, starredAt: "2026-10-01T00:00:00.000Z" };
}

function makeClient(overrides: Partial<PaletteClient> = {}): PaletteClient {
  return {
    search: vi.fn(async () => []),
    listStarred: vi.fn(async () => []),
    star: vi.fn(async () => null),
    unstar: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPalette(
  client: PaletteClient | null,
  props: Partial<React.ComponentProps<typeof CommandPalette>> = {},
) {
  const host: PaletteHostValue = { scope: "org-1", client };
  const onOpenTarget = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <PaletteHostProvider value={host}>
      <CommandPalette onClose={onClose} actions={[]} onOpenTarget={onOpenTarget} {...props} />
    </PaletteHostProvider>,
  );
  return { ...utils, onOpenTarget, onClose };
}

const input = () => screen.getByRole("combobox");

beforeEach(() => {
  useStarredStore.setState({ scope: null, items: null, error: null, busy: new Set() });
  useRecentsStore.setState({ byScope: {} });
  clearPaletteIntents();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandPalette", () => {
  it("lists starred items, then recents, then suggested actions on an empty query", async () => {
    const client = makeClient({
      listStarred: vi.fn(async () => [starred("cost_report", "r1", "Team spend")]),
    });
    useRecentsStore.getState().record("org-1", { kind: "costs" }, "Costs");
    const run = vi.fn();
    const actions: PaletteAction[] = [
      { id: "a", label: "Create budget", group: "create", suggested: true, run },
      { id: "b", label: "Go to Probes", group: "go", run },
    ];
    renderPalette(client, { actions });

    await screen.findByRole("option", { name: /Team spend/ });
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-labelledby"));
    expect(groups).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Starred" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Create budget/ })).toBeInTheDocument();
    // Unsuggested actions wait for a query.
    expect(screen.queryByRole("option", { name: /Go to Probes/ })).toBeNull();
  });

  it("filters to actions only behind a > prefix", async () => {
    const client = makeClient();
    const actions: PaletteAction[] = [
      { id: "a", label: "Create budget", group: "create", run: vi.fn() },
      { id: "b", label: "Go to Probes", group: "go", run: vi.fn() },
    ];
    renderPalette(client, { actions });
    fireEvent.change(input(), { target: { value: ">probe" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Go to Probes");
    expect(client.search).not.toHaveBeenCalled();
  });

  it("debounces the server search and groups hits by kind", async () => {
    const search = vi.fn(async (_query: string, _signal: AbortSignal) => [
      hit("dashboard", "d1", "Prod overview"),
      hit("cost_report", "r1", "Prod spend"),
    ]);
    renderPalette(makeClient({ search }));
    fireEvent.change(input(), { target: { value: "p" } });
    fireEvent.change(input(), { target: { value: "prod" } });
    await screen.findByRole("option", { name: /Prod overview/ });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toBe("prod");
    expect(screen.getByRole("group", { name: "Dashboards" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Cost reports" })).toBeInTheDocument();
  });

  it("opens the active hit's tab on Enter, and in a new tab with the modifier", async () => {
    const search = vi.fn(async () => [hit("slo", "s1", "Checkout latency")]);
    const { onOpenTarget, onClose } = renderPalette(makeClient({ search }));
    fireEvent.change(input(), { target: { value: "checkout" } });
    await screen.findByRole("option", { name: /Checkout latency/ });
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    expect(onClose).toHaveBeenCalled();
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: "slos", sloId: "s1" }, "Checkout latency", {
      newTab: true,
    });
  });

  it("ranks local results with the shared matcher", () => {
    renderPalette(null, {
      localResults: [hit("resource", "r1", "web-1"), hit("resource", "r2", "db-primary")],
    });
    fireEvent.change(input(), { target: { value: "db" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("db-primary");
  });

  it("stars the active hit with the modifier+S shortcut", async () => {
    const star = vi.fn(async () => starred("dashboard", "d1", "Prod overview"));
    const client = makeClient({
      search: vi.fn(async () => [hit("dashboard", "d1", "Prod overview")]),
      star,
    });
    renderPalette(client);
    await waitFor(() => expect(client.listStarred).toHaveBeenCalled());
    fireEvent.change(input(), { target: { value: "prod" } });
    await screen.findByRole("option", { name: /Prod overview/ });
    fireEvent.keyDown(input(), { key: "s", metaKey: true });
    await waitFor(() => expect(star).toHaveBeenCalledWith({ kind: "dashboard", id: "d1" }));
    expect(await screen.findByRole("button", { name: /Unstar Prod overview/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("names an empty result and points at actions", () => {
    renderPalette(null);
    expect(screen.getByText(/Type > for actions/)).toBeInTheDocument();
  });
});

describe("paletteDestination", () => {
  it("maps every kind to a tab", () => {
    for (const kind of SEARCH_RESULT_KINDS) {
      const dest = paletteDestination(hit(kind, "x", "X"));
      expect(dest.target.kind).toBeTruthy();
    }
  });

  it("opens objects without a tab of their own on their page, with a focus intent", () => {
    expect(paletteDestination(hit("budget", "b1", "B"))).toEqual({
      target: { kind: "costs" },
      intent: { type: "focus", kind: "budget", id: "b1" },
    });
    expect(paletteDestination(hit("virtual_tag", "v1", "V")).target).toEqual({
      kind: "settings",
      section: "virtual-tags",
    });
  });

  it("opens resources with their account and type", () => {
    expect(paletteDestination(hit("resource", "i-1", "web")).target).toMatchObject({
      kind: "resource",
      accountId: "acc-1",
      resourceId: "i-1",
      pluginId: "aws",
      resourceTypeId: "ec2",
    });
  });
});

describe("starRefFromTarget", () => {
  it("names the object a tab shows, and nothing for list pages", () => {
    expect(starRefFromTarget({ kind: "cost-reports", reportId: "r1" })).toEqual({
      kind: "cost_report",
      id: "r1",
    });
    expect(starRefFromTarget({ kind: "cost-reports" })).toBeNull();
    expect(starRefFromTarget({ kind: "costs" })).toBeNull();
    expect(
      starRefFromTarget({ kind: "resource", accountId: "a", resourceId: "r", view: "ssh" }),
    ).toBeNull();
  });
});

describe("recents", () => {
  it("dedupes by tab and caps the list", () => {
    let list = pushRecent([], {
      id: "a",
      target: { kind: "costs" },
      title: "Costs",
      at: 1,
    });
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      list = pushRecent(list, { id: `t${i}`, target: { kind: "costs" }, title: `${i}`, at: i });
    }
    list = pushRecent(list, { id: "t3", target: { kind: "costs" }, title: "again", at: 99 });
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0]!.title).toBe("again");
    expect(list.filter((e) => e.id === "t3")).toHaveLength(1);
  });

  it("keys entries by workspace tab id, per scope", () => {
    const target = { kind: "slos" as const, sloId: "s1" };
    useRecentsStore.getState().record("org-1", target, "SLO");
    useRecentsStore.getState().record("org-2", { kind: "costs" }, "Costs");
    expect(useRecentsStore.getState().byScope["org-1"]![0]!.id).toBe(getWorkspaceTabId(target));
    expect(useRecentsStore.getState().byScope["org-2"]).toHaveLength(1);
  });
});

describe("palette intents", () => {
  it("delivers an intent to a claimant mounted later, once", () => {
    requestPaletteIntent({ type: "create", kind: "slo" });
    const handler = vi.fn();
    renderHook(() => usePaletteIntent((i) => i.type === "create" && i.kind === "slo", handler));
    expect(handler).toHaveBeenCalledTimes(1);
    renderHook(() => usePaletteIntent(() => true, handler));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves intents it does not match for someone else", () => {
    const other = vi.fn();
    renderHook(() => usePaletteIntent((i) => i.kind === "budget", other));
    act(() => requestPaletteIntent({ type: "create", kind: "slo" }));
    expect(other).not.toHaveBeenCalled();
    const mine = vi.fn();
    renderHook(() => usePaletteIntent((i) => i.kind === "slo", mine));
    expect(mine).toHaveBeenCalledOnce();
  });

  it("drops intents nobody claimed in time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    requestPaletteIntent({ type: "create", kind: "dashboard" });
    vi.setSystemTime(new Date(Date.now() + PALETTE_INTENT_TTL_MS + 1));
    const late = vi.fn();
    renderHook(() => usePaletteIntent(() => true, late));
    expect(late).not.toHaveBeenCalled();
  });
});
