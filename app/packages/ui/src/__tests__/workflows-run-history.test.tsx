import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowRunHistory } from "../workflows/RunHistory.js";
import { WorkflowsPanel } from "../workflows/WorkflowsPanel.js";
import type { WorkflowClient, WorkflowRunRow, WorkflowSummary } from "../workflows/types.js";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="workflow-editor" />,
}));

const HOUR = 3_600_000;

function runRow(over: Partial<WorkflowRunRow> & { id: string }): WorkflowRunRow {
  return {
    status: "success",
    triggerSource: "cron",
    logs: [],
    error: null,
    durationMs: 1200,
    startedAt: new Date(Date.now() - HOUR).toISOString(),
    finishedAt: new Date(Date.now() - HOUR + 1200).toISOString(),
    ...over,
  };
}

describe("WorkflowRunHistory", () => {
  it("says so when the workflow has never run", () => {
    render(<WorkflowRunHistory runs={[]} />);
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });

  it("points at the live panel when the very first run is in flight", () => {
    render(<WorkflowRunHistory runs={[]} liveRunActive />);
    expect(screen.getByText(/first run is in progress/)).toBeInTheDocument();
  });

  it("lists runs newest first with status, duration and trigger", () => {
    render(
      <WorkflowRunHistory
        runs={[
          runRow({
            id: "older",
            status: "failure",
            triggerSource: "manual",
            durationMs: 90_000,
            startedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
          }),
          runRow({ id: "newer", triggerSource: "git", durationMs: 400 }),
        ]}
      />,
    );

    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("success")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("400ms")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Git push")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("failure")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("1m 30s")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Manual")).toBeInTheDocument();
  });

  it("expands a run to its logs, error and output", () => {
    render(
      <WorkflowRunHistory
        runs={[
          runRow({
            id: "r1",
            status: "failure",
            logs: [
              { at: 1, level: "info", message: "starting up" },
              { at: 2, level: "error", message: "it broke" },
            ],
            error: { message: "boom" },
            output: { replicas: 3 },
          }),
        ]}
      />,
    );

    expect(screen.queryByText("starting up")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByText("starting up")).toBeInTheDocument();
    expect(screen.getByText("it broke")).toBeInTheDocument();
    expect(screen.getByText("Error: boom")).toBeInTheDocument();
    expect(screen.getByText(/"replicas": 3/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide logs" }));
    expect(screen.queryByText("starting up")).not.toBeInTheDocument();
  });

  it("shows an in-progress run as in progress rather than a duration", () => {
    render(
      <WorkflowRunHistory
        runs={[runRow({ id: "r1", status: "running", durationMs: null, finishedAt: null })]}
      />,
    );
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
  });

  it("caps the list and reveals the rest on request", () => {
    const runs = Array.from({ length: 14 }, (_, i) =>
      runRow({ id: `r${i}`, startedAt: new Date(Date.now() - i * HOUR).toISOString() }),
    );
    render(<WorkflowRunHistory runs={runs} />);

    expect(screen.getAllByRole("row")).toHaveLength(11); // header + 10
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(screen.getAllByRole("row")).toHaveLength(15);
  });

  it("defers to the panel above for the run the editor just made", () => {
    render(<WorkflowRunHistory runs={[runRow({ id: "r1" })]} currentRunId="r1" />);
    expect(screen.getByText("shown above")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Logs" })).not.toBeInTheDocument();
  });

  it("marks the current run as streaming while it is still going", () => {
    render(
      <WorkflowRunHistory
        runs={[runRow({ id: "r1", status: "running" })]}
        currentRunId="r1"
        liveRunActive
      />,
    );
    expect(screen.getByText("streaming above")).toBeInTheDocument();
  });

  it("collapses and re-expands the whole section", () => {
    render(<WorkflowRunHistory runs={[runRow({ id: "r1" })]} />);
    const toggle = screen.getByRole("button", { name: /Run history/ });
    fireEvent.click(toggle);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

const workflow: WorkflowSummary = {
  id: "w1",
  name: "Nightly cleanup",
  source: "infra.log('ok')",
  trigger: { kind: "cron", expression: "0 0 * * *" },
  metricDefs: [],
  assignedSecretIds: [],
  enabled: true,
};

describe("WorkflowsPanel run history", () => {
  it("renders the runs it fetched for the selected workflow", async () => {
    const client = {
      list: vi.fn(async () => [workflow]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      getTypings: vi.fn(async () => "interface InfraApi {}"),
      run: vi.fn(),
      listRuns: vi.fn(async () => [
        runRow({ id: "r1", logs: [{ at: 1, level: "info", message: "cleaned 4 volumes" }] }),
      ]),
      listMetrics: vi.fn(async () => []),
      getAssignedSecrets: vi.fn(async () => ({ assignedSecretIds: [], secrets: [] })),
      listSecrets: vi.fn(async () => []),
      upsertSecret: vi.fn(),
      deleteSecret: vi.fn(),
    } satisfies WorkflowClient;

    render(<WorkflowsPanel client={client} />);
    fireEvent.click(await screen.findByText("Nightly cleanup"));

    await waitFor(() => expect(client.listRuns).toHaveBeenCalledWith("w1"));
    expect(await screen.findByRole("table", { name: "Run history" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByText("cleaned 4 volumes")).toBeInTheDocument();
  });

  it("drops the previous workflow's runs the moment another is selected", async () => {
    const other: WorkflowSummary = { ...workflow, id: "w2", name: "Cost report" };
    let resolveSecondFetch: ((rows: WorkflowRunRow[]) => void) | undefined;
    const client = {
      list: vi.fn(async () => [workflow, other]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      getTypings: vi.fn(async () => "interface InfraApi {}"),
      run: vi.fn(),
      listRuns: vi.fn(async (id: string) =>
        id === "w1"
          ? [runRow({ id: "r1", triggerSource: "git" })]
          : new Promise<WorkflowRunRow[]>((r) => {
              resolveSecondFetch = r;
            }),
      ),
      listMetrics: vi.fn(async () => []),
      getAssignedSecrets: vi.fn(async () => ({ assignedSecretIds: [], secrets: [] })),
      listSecrets: vi.fn(async () => []),
      upsertSecret: vi.fn(),
      deleteSecret: vi.fn(),
    } satisfies WorkflowClient;

    render(<WorkflowsPanel client={client} />);
    fireEvent.click(await screen.findByText("Nightly cleanup"));
    expect(await screen.findByText("Git push")).toBeInTheDocument();

    // The second workflow's runs are still in flight — the first one's history
    // must not stand in for them.
    fireEvent.click(screen.getByText("Cost report"));
    await waitFor(() => expect(screen.queryByText("Git push")).not.toBeInTheDocument());
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();

    resolveSecondFetch?.([runRow({ id: "r2", triggerSource: "budget" })]);
    expect(await screen.findByText("Budget")).toBeInTheDocument();
  });
});
