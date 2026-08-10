import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalsInbox } from "../workflows/ApprovalsInbox.js";
import { formatExpiry } from "../workflows/ApprovalCard.js";
import type { ApprovalsClient, WorkflowApprovalRow } from "../workflows/types.js";

function approval(overrides: Partial<WorkflowApprovalRow> = {}): WorkflowApprovalRow {
  return {
    id: "a1",
    workflowId: "wf1",
    workflowName: "Nightly prune",
    runId: "11111111-2222-3333-4444-555555555555",
    title: "Delete 3 orphaned volumes",
    message: "vol-a, vol-b, vol-c in eu-west-1",
    status: "pending",
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    decidedAt: null,
    decidedByName: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeClient(rows: WorkflowApprovalRow[], overrides: Partial<ApprovalsClient> = {}) {
  return {
    list: vi.fn(async () => rows),
    decide: vi.fn(async (id: string) => ({ ...approval({ id }), status: "approved" as const })),
    ...overrides,
  } satisfies ApprovalsClient;
}

describe("formatExpiry", () => {
  const now = Date.parse("2026-07-31T12:00:00Z");

  it("counts down while pending", () => {
    expect(formatExpiry("2026-07-31T12:30:00Z", now)).toBe("expires in 30m");
    expect(formatExpiry("2026-07-31T14:00:00Z", now)).toBe("expires in 2h");
    expect(formatExpiry("2026-08-02T12:00:00Z", now)).toBe("expires in 2d");
  });

  it("reads as past tense once the window has closed", () => {
    expect(formatExpiry("2026-07-31T11:55:00Z", now)).toBe("expired 5m ago");
  });
});

describe("ApprovalsInbox", () => {
  it("lists pending requests across the org with their workflow", async () => {
    const client = makeClient([approval()]);
    render(<ApprovalsInbox client={client} />);
    await waitFor(() => expect(screen.getByText(/Delete 3 orphaned volumes/)).toBeInTheDocument());
    expect(client.list).toHaveBeenCalledWith("pending");
    expect(screen.getByText("Nightly prune")).toBeInTheDocument();
    expect(screen.getByText(/vol-a, vol-b, vol-c/)).toBeInTheDocument();
  });

  it("decides inline and drops the row without waiting for the next poll", async () => {
    const client = makeClient([approval()]);
    render(<ApprovalsInbox client={client} />);
    await waitFor(() => expect(screen.getByText("Approve")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(client.decide).toHaveBeenCalledWith("a1", "approve"));
  });

  /**
   * `workflows:read` without `workflows:approve`: the requests are visible so
   * the team can see what is blocked, but this viewer cannot land a decision.
   */
  it("hides Approve/Deny when the viewer cannot approve", async () => {
    const client = makeClient([approval()]);
    render(<ApprovalsInbox client={client} canDecide={false} />);
    await waitFor(() => expect(screen.getByText(/Delete 3 orphaned volumes/)).toBeInTheDocument());
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Deny")).not.toBeInTheDocument();
  });

  it("says so when nothing is waiting", async () => {
    const client = makeClient([]);
    render(<ApprovalsInbox client={client} />);
    await waitFor(() => expect(screen.getByText(/Nothing waiting/)).toBeInTheDocument());
  });

  it("renders nothing at all in hideWhenEmpty hosts", async () => {
    const client = makeClient([]);
    const { container } = render(<ApprovalsInbox client={client} hideWhenEmpty />);
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("surfaces a conflict from a request someone else already decided", async () => {
    const client = makeClient([approval()], {
      decide: vi.fn(async () => {
        throw new Error("This request has already been decided or has expired.");
      }),
    });
    render(<ApprovalsInbox client={client} />);
    await waitFor(() => expect(screen.getByText("Deny")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Deny"));
    await waitFor(() => expect(screen.getByText(/already been decided/)).toBeInTheDocument());
  });
});
