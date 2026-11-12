import { beforeAll, describe, expect, it, vi } from "vitest";
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

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close.
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
});

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

const RETRY_ID = "33333333-3333-4333-8333-333333333333";

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
    retryRun: vi.fn(async (id: string, opts: { noTaskCache: boolean }) => ({
      ...run,
      id: RETRY_ID,
      status: "queued" as const,
      retryOfRunId: id,
      noTaskCache: opts.noTaskCache,
    })),
    cancelRun: vi.fn(async (id: string) => ({
      ...run,
      id,
      status: "running" as const,
      cancelRequested: true,
    })),
    listCaches: vi.fn(async () => ({
      accounts: [
        {
          installationId: 7,
          accountLogin: "acme",
          usedBytes: 3 * 1024 ** 2,
          quotaBytes: 10 * 1024 ** 3,
          repos: [{ repo: "web", bytes: 3 * 1024 ** 2, entries: 12 }],
          error: null,
        },
      ],
    })),
    clearCache: vi.fn(async (installationId: number, repo: string) => ({
      installationId,
      repo,
      deletedEntries: 12,
      deletedBytes: 3 * 1024 ** 2,
    })),
    streamRunLogs: vi.fn(async function* (): AsyncIterable<CiLogEvent> {}),
    downloadLink: vi.fn(async () => ({
      url: "https://ci-proxy.example/v1/artifacts/o/r/run/1-x?n=report.html&e=1&s=x",
      expiresAt: "2026-11-09T10:15:00.000Z",
    })),
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
    expect(c.listCaches).toHaveBeenCalledTimes(1);
  });

  it("opens a run from anywhere on its row, but not from the approval buttons", async () => {
    const waiting: CiRun = {
      ...run,
      id: "22222222-2222-4222-8222-222222222222",
      sha: "b".repeat(40),
      status: "awaiting_approval",
    };
    const c = { ...client(), listRuns: vi.fn(async () => [run, waiting]) };
    const onSelectRun = vi.fn();
    render(
      <CiPanel client={c} selectedRunId={null} onSelectRun={onSelectRun} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("aaaaaaa")).toBeTruthy());

    fireEvent.click(screen.getByText("aaaaaaa"));
    expect(onSelectRun).toHaveBeenLastCalledWith(run.id);

    fireEvent.click(screen.getByText("bbbbbbb"));
    expect(onSelectRun).toHaveBeenLastCalledWith(waiting.id);

    onSelectRun.mockClear();
    fireEvent.click(screen.getByText("Approve"));
    expect(onSelectRun).not.toHaveBeenCalled();
    expect(screen.getByText("Approve and run")).toBeTruthy();
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

  it("retries a finished run, with or without the task cache, and opens the retry", async () => {
    const c = client();
    c.getRun.mockResolvedValue({ run: { ...run, status: "failed" }, jobs: [] });
    const onSelectRun = vi.fn();
    render(
      <CiPanel client={c} selectedRunId={run.id} onSelectRun={onSelectRun} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry without cache" }));
    await waitFor(() => expect(onSelectRun).toHaveBeenCalledWith(RETRY_ID));
    expect(c.retryRun).toHaveBeenCalledWith(run.id, { noTaskCache: true });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(c.retryRun).toHaveBeenCalledTimes(2));
    expect(c.retryRun).toHaveBeenLastCalledWith(run.id, { noTaskCache: false });
  });

  it("offers no retry without ci:approve, nor for a run waiting for approval", async () => {
    const c = client();
    c.getRun.mockResolvedValue({ run, jobs: [] });
    const { unmount } = render(
      <CiPanel
        client={c}
        selectedRunId={run.id}
        onSelectRun={() => {}}
        canWrite
        canApprove={false}
      />,
    );
    await waitFor(() => expect(screen.getByText("Open on GitHub")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    unmount();

    c.getRun.mockResolvedValue({
      run: { ...run, status: "awaiting_approval", fromFork: true },
      jobs: null,
    });
    render(
      <CiPanel client={c} selectedRunId={run.id} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("Approve")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry without cache" })).toBeNull();
  });

  it("links a retry and the run it retries", async () => {
    const c = client();
    c.getRun.mockResolvedValue({
      run: {
        ...run,
        id: RETRY_ID,
        retryOfRunId: run.id,
        retriedAsRunId: "44444444-4444-4444-8444-444444444444",
        noTaskCache: true,
      },
      jobs: [],
    });
    const onSelectRun = vi.fn();
    render(
      <CiPanel client={c} selectedRunId={RETRY_ID} onSelectRun={onSelectRun} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("Retry of run 11111111")).toBeTruthy());
    expect(screen.getByText("Without the task cache")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry of run 11111111"));
    expect(onSelectRun).toHaveBeenLastCalledWith(run.id);
    fireEvent.click(screen.getByText("Retried as run 44444444"));
    expect(onSelectRun).toHaveBeenLastCalledWith("44444444-4444-4444-8444-444444444444");
  });

  it("cancels a running run, says it is cancelling, and shows its groups", async () => {
    const c = client();
    const running: CiRun = {
      ...run,
      status: "running",
      finishedAt: null,
      jobs: null,
      concurrencyGroups: ["ci-feature"],
    };
    c.getRun
      .mockResolvedValueOnce({ run: running, jobs: null })
      .mockResolvedValue({ run: { ...running, cancelRequested: true }, jobs: null });
    render(
      <CiPanel client={c} selectedRunId={run.id} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());
    expect(screen.getByText("ci-feature")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(c.cancelRun).toHaveBeenCalledWith(run.id));
    await waitFor(() => expect(screen.getByText("Cancelling…")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("offers no cancel without ci:approve, and a retry for a cancelled run", async () => {
    const c = {
      ...client(),
      listRuns: vi.fn(async () => [
        { ...run, status: "pending" as const, statusReason: "Waiting for its group" },
      ]),
    };
    const { unmount } = render(
      <CiPanel
        client={c}
        selectedRunId={null}
        onSelectRun={() => {}}
        canWrite
        canApprove={false}
      />,
    );
    // The badge, beside the status filter's option.
    await waitFor(() => expect(screen.getAllByText("Waiting")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    unmount();

    const cancelled = {
      ...client(),
      listRuns: vi.fn(async () => [{ ...run, status: "cancelled" as const }]),
    };
    render(
      <CiPanel
        client={cancelled}
        selectedRunId={null}
        onSelectRun={() => {}}
        canWrite
        canApprove
      />,
    );
    await waitFor(() => expect(screen.getAllByText("Cancelled")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("retries a failed run from the list without opening it", async () => {
    const failed: CiRun = { ...run, status: "failed" };
    const c = { ...client(), listRuns: vi.fn(async () => [failed]) };
    const onSelectRun = vi.fn();
    render(
      <CiPanel client={c} selectedRunId={null} onSelectRun={onSelectRun} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    // The list offers the one retry; without the cache is on the run's page.
    expect(screen.queryByRole("button", { name: "Retry without cache" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(c.retryRun).toHaveBeenCalledWith(run.id, { noTaskCache: false }));
    expect(onSelectRun).not.toHaveBeenCalled();
    // The list reloads to show the new run.
    await waitFor(() => expect(c.listRuns).toHaveBeenCalledTimes(2));
  });

  it("clears a repository's cache after confirming, and says what went", async () => {
    const c = client();
    render(<CiPanel client={c} selectedRunId={null} onSelectRun={() => {}} canWrite canApprove />);
    const clear = await screen.findByRole("button", { name: "Clear the cache of acme/web" });
    expect(screen.getByText("3.00 MiB")).toBeTruthy();
    fireEvent.click(clear);
    // The dialog says what it deletes before anything is.
    expect(screen.getByText("Clear the cache of acme/web?")).toBeTruthy();
    expect(screen.getByText(/This deletes 12 cache entries \(3.00 MiB\)/)).toBeTruthy();
    expect(c.clearCache).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Clear the cache of acme/web?")).toBeNull();
    expect(c.clearCache).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear the cache of acme/web" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
    await waitFor(() =>
      expect(screen.getByText("Cleared 12 cache entries (3.00 MiB) from acme/web.")).toBeTruthy(),
    );
    expect(c.clearCache).toHaveBeenCalledWith(7, "web");
    // The list is read again after clearing.
    await waitFor(() => expect(c.listCaches).toHaveBeenCalledTimes(2));
  });

  it("shows caches without the clear button to members without ci:write", async () => {
    const c = client();
    render(
      <CiPanel
        client={c}
        selectedRunId={null}
        onSelectRun={() => {}}
        canWrite={false}
        canApprove
      />,
    );
    await waitFor(() => expect(screen.getByText("3.00 MiB")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Clear the cache/ })).toBeNull();
  });

  it("lists a finished run's downloads and starts one from a signed link", async () => {
    const c = client();
    const built: CiJobOutput = {
      ...output("build", "Build", [], "built"),
      downloads: [
        {
          path: "dist/report.html",
          size: 2048,
          sha256: "c".repeat(64),
          contentType: "text/html; charset=utf-8",
          expiresAt: "2099-12-01T00:00:00.000Z",
          masked: true,
        },
        {
          path: "dist/app.tar.gz",
          size: 10,
          sha256: "d".repeat(64),
          contentType: "application/gzip",
          expiresAt: "2000-01-01T00:00:00.000Z",
          masked: false,
        },
      ],
    };
    c.getRun.mockResolvedValue({ run, jobs: [built, output("lint", "Lint", [], "ok")] });
    const onDownloadUrl = vi.fn();
    render(
      <CiPanel
        client={c}
        selectedRunId={run.id}
        onSelectRun={() => {}}
        canWrite
        canApprove
        onDownloadUrl={onDownloadUrl}
      />,
    );
    // The run's summary lists every job's files.
    await waitFor(() => expect(screen.getByText("dist/report.html")).toBeTruthy());
    expect(screen.getByText("dist/app.tar.gz")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("Binary: stored as the job left it")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Download" });
    // An expired file cannot be fetched.
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(onDownloadUrl).toHaveBeenCalledWith(
        "https://ci-proxy.example/v1/artifacts/o/r/run/1-x?n=report.html&e=1&s=x",
      ),
    );
    expect(c.downloadLink).toHaveBeenCalledWith(run.id, "build", "dist/report.html");

    // A job's own output lists its files too; a failed link says why.
    c.downloadLink.mockRejectedValueOnce(new Error("That download has expired."));
    fireEvent.click(screen.getAllByRole("button", { name: /Build/ })[0]!);
    await waitFor(() => expect(screen.getByText("built")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Download" })[0]!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("expired"));
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
