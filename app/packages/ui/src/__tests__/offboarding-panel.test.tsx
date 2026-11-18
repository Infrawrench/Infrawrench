import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Offboarding, OffboardingItem } from "@infrawrench/client-core";

import { OffboardingPanel, type OffboardingClient } from "../offboarding/OffboardingPanel.js";

function item(over: Partial<OffboardingItem>): OffboardingItem {
  return {
    id: "i1",
    kind: "seat",
    title: "Copilot Business",
    detail: "business",
    pluginId: "github",
    providerName: "GitHub",
    accountId: "a1",
    accountName: "acme-org",
    resourceId: null,
    resourceTypeId: null,
    confidence: "exact",
    matchReason: "Their email in the seat's email",
    matchState: "matched",
    actions: ["remove-seat"],
    status: "open",
    resolution: null,
    lastError: null,
    note: null,
    resolvedByName: null,
    resolvedAt: null,
    firstSeenAt: "2026-11-08T10:00:00.000Z",
    lastSeenAt: "2026-11-08T10:00:00.000Z",
    ...over,
  };
}

const offboarding: Offboarding = {
  id: "off-1",
  email: "jane@example.com",
  name: "Jane Doe",
  userId: null,
  aliases: ["jdoe"],
  status: "open",
  source: "manual",
  sourceDetail: null,
  startedByName: "Ada",
  note: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
  completedAt: null,
  lastScannedAt: null,
  scanTruncated: false,
  progress: { total: 2, resolved: 0, open: 2, failed: 0, unconfirmed: 1 },
  items: [
    item({}),
    item({
      id: "i2",
      kind: "principal",
      title: "jane",
      providerName: "GitLab",
      confidence: "possible",
      matchState: "unconfirmed",
      matchReason: '"jane" in the name matches the start of their email',
      actions: ["remove"],
    }),
  ],
};

function client(over: Partial<OffboardingClient> = {}): OffboardingClient {
  return {
    list: vi.fn(async () => ({ offboardings: [offboarding] })),
    get: vi.fn(async () => offboarding),
    start: vi.fn(async () => ({ offboarding, created: true })),
    update: vi.fn(async () => offboarding),
    rescan: vi.fn(async () => offboarding),
    updateItem: vi.fn(async (_id, itemId, patch) => ({
      ...offboarding.items.find((i) => i.id === itemId)!,
      ...(patch.matchState ? { matchState: patch.matchState } : {}),
    })),
    act: vi.fn(async (_id, itemId) => ({
      item: { ...offboarding.items.find((i) => i.id === itemId)!, status: "done" as const },
      message: null,
    })),
    members: vi.fn(async () => ({ members: [] })),
    exportCsv: vi.fn(),
    ...over,
  };
}

describe("OffboardingPanel", () => {
  it("starts an offboarding from the list and opens it", async () => {
    const c = client();
    const onSelect = vi.fn();
    render(<OffboardingPanel client={c} onSelect={onSelect} />);
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("jane@example.com"), {
      target: { value: "sam@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("GitHub login, other addresses"), {
      target: { value: "@Sam-GH, sam" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start offboarding" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("off-1"));
    expect(c.start).toHaveBeenCalledWith({ email: "sam@example.com", aliases: ["sam-gh", "sam"] });
  });

  it("holds a possible match back until it is confirmed", async () => {
    const c = client();
    render(<OffboardingPanel client={c} offboardingId="off-1" onSelect={vi.fn()} />);
    expect(await screen.findByText("Copilot Business")).toBeInTheDocument();
    // The exact match offers its action; the possible one only asks.
    expect(screen.getByRole("button", { name: "Remove seat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "It's them" }));
    await waitFor(() =>
      expect(c.updateItem).toHaveBeenCalledWith("off-1", "i2", { matchState: "confirmed" }),
    );
    expect(await screen.findByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("asks before an action that cannot be undone, then records it", async () => {
    const c = client();
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(<OffboardingPanel client={c} offboardingId="off-1" onSelect={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove seat" }));
    expect(c.act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove seat" }));
    await waitFor(() =>
      expect(c.act).toHaveBeenCalledWith("off-1", "i1", { action: "remove-seat" }),
    );
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });
});
