import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CiJobOutput, CiLogEvent, CiRun, CiStatus } from "@infrawrench/client-core";

// gt-react's `gt` is not referentially stable: a fresh function on every
// render. The panel once listed it in its fetch effects' deps, which
// refetched on every render, cancelled each fetch before it landed, and left
// the runs list empty and the secrets card loading forever. Give it a new
// `gt` every render here so a dependency on it shows up as a loop.
vi.mock("gt-react", () => ({
  useGT: () => (s: string, vars?: Record<string, string>) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => vars?.[k] ?? ""),
}));

const { CiPanel } = await import("../ci/CiPanel.js");

const status: CiStatus = {
  enabled: true,
  configured: true,
  githubConfigured: true,
  planIncludesCi: true,
  accounts: [
    { installationId: 7, accountLogin: "acme", accountType: "Organization", ciEnabled: true },
  ],
};

const run: CiRun = {
  id: "11111111-1111-4111-8111-111111111111",
  repoFullName: "acme/web",
  event: "pull-request",
  headRef: "feature",
  sha: "a".repeat(40),
  pullNumber: 4,
  headRepoFullName: "acme/web",
  fromFork: false,
  actorLogin: "octo",
  status: "passed",
  statusReason: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  startedAt: "2026-11-09T10:00:01.000Z",
  finishedAt: "2026-11-09T10:01:00.000Z",
  jobs: [],
  vcpuSeconds: 1,
  memoryGibSeconds: 2,
  githubUrl: "https://github.com/acme/web/pull/4",
};

function client() {
  return {
    status: vi.fn(async () => status),
    setAccount: vi.fn(),
    installUrl: vi.fn(async () => null),
    listRuns: vi.fn(async () => [run]),
    getRun: vi.fn(),
    approveRun: vi.fn(),
    rejectRun: vi.fn(),
    usage: vi.fn(async () => ({
      month: "2026-11",
      runs: 1,
      vcpuSeconds: 1,
      memoryGibSeconds: 2,
      storageGibHours: 0,
      storageBytes: null,
    })),
    listRepos: vi.fn(async () => ["web"]),
    listValues: vi.fn(async () => ({
      installationId: 7,
      repo: null,
      secrets: [{ name: "NPM_TOKEN", updatedAt: "2026-11-09T10:00:00.000Z" }],
      variables: [],
    })),
    setValue: vi.fn(),
    deleteValue: vi.fn(),
    streamRunLogs: vi.fn(async function* (): AsyncIterable<CiLogEvent> {}),
  };
}

const output = (id: string, name: string, needs: string[], stdout: string): CiJobOutput => ({
  pipeline: "Test",
  id,
  name,
  status: "passed",
  reason: null,
  durationMs: 2000,
  needs,
  stdout,
  stderr: "",
});

describe("CiPanel", () => {
  it("shows the runs and the secrets, fetching each once", async () => {
    const c = client();
    render(<CiPanel client={c} selectedRunId={null} onSelectRun={() => {}} canWrite canApprove />);
    await waitFor(() => expect(screen.getByText("acme/web")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("NPM_TOKEN")).toBeTruthy());
    // Let any loop show itself.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(c.status).toHaveBeenCalledTimes(1);
    expect(c.listRuns).toHaveBeenCalledTimes(1);
    expect(c.listValues).toHaveBeenCalledTimes(1);
  });

  it("draws a finished run as a graph, and opens a job's output from it", async () => {
    const c = client();
    c.getRun.mockResolvedValue({
      run,
      jobs: [
        output("prep", "Prepare", [], "prepared"),
        output("build[app/a]", "Build a", ["prep"], "built a"),
        output("build[app/b]", "Build b", ["prep", "build[app/a]"], "built b"),
      ],
    });
    render(
      <CiPanel client={c} selectedRunId={run.id} onSelectRun={() => {}} canWrite canApprove />,
    );
    // The pipeline's graph, the packages' jobs grouped under their key.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Test" })).toBeTruthy());
    expect(screen.getAllByText("build").length).toBeGreaterThan(0);
    // A job opens its output; Summary goes back to the graph.
    fireEvent.click(screen.getAllByRole("button", { name: /Build b/ })[0]!);
    await waitFor(() => expect(screen.getByText("built b")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Test" })).toBeTruthy());
    expect(c.streamRunLogs).not.toHaveBeenCalled();
  });

  it("follows a running run's live log, once", async () => {
    const c = client();
    c.getRun.mockResolvedValue({
      run: { ...run, status: "running", finishedAt: null },
      jobs: null,
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    c.streamRunLogs.mockImplementation(async function* (): AsyncIterable<CiLogEvent> {
      yield {
        event: "pipeline-started",
        pipeline: "Test",
        jobs: [
          { key: "prep", name: "Prepare", needs: [], ids: ["prep"] },
          { key: "lint", name: "Lint", needs: ["prep"], ids: ["lint"] },
        ],
      };
      yield { event: "job-started", job: "prep", name: "Prepare" };
      yield { event: "output", job: "prep", stream: "stdout", line: "installing" };
      // The run is still going.
      await held;
    });
    render(
      <CiPanel client={c} selectedRunId={run.id} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Prepare/ }).length).toBe(2));
    // Lint has not started: it waits in the graph.
    expect(screen.getAllByRole("button", { name: /Lint/ }).length).toBe(2);
    fireEvent.click(screen.getAllByRole("button", { name: /Prepare/ })[0]!);
    await waitFor(() => expect(screen.getByText("installing")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(c.streamRunLogs).toHaveBeenCalledTimes(1);
    release();
  });
});
