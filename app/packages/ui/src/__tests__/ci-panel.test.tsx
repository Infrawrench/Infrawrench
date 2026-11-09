import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { CiRun, CiStatus } from "@infrawrench/client-core";

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
  };
}

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
});
