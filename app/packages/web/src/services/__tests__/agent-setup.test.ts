import { describe, it, expect, vi, beforeEach } from "vitest";
import { T3_CODE_PROJECTS_DIR } from "@infrawrench/ui/agents/t3-code";

// Drizzle-style chain mocks. Selects resolve queued results in call order;
// update captures the values passed to .set().
const selectResults: unknown[][] = [];
const updateSetCalls: Array<Record<string, unknown>> = [];
// Rows the next `.returning()` yields — the setup-lease claim reads this to
// decide whether this replica won the row. Defaults to winning.
const updateReturning: unknown[][] = [];

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResults.shift() ?? []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const where = () => {
          updateSetCalls.push(values);
          const result: Promise<unknown> & { returning?: () => Promise<unknown[]> } =
            Promise.resolve() as never;
          result.returning = () =>
            Promise.resolve(updateReturning.shift() ?? [{ id: "session-1" }]);
          return result;
        };
        return { where };
      },
    }),
  },
}));

vi.mock("@/services/plugin-clients", () => ({
  getClientForAccount: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue("PRIVATE-KEY"),
  buildAad: vi.fn().mockReturnValue(Buffer.from("aad")),
}));

const {
  AGENT_SETUP_COMPLETE_LOG,
  createAgentSetupPlanForRepo,
  ensureAgentVmSetupForSession,
  extractBootstrapWarning,
  hasAgentSetupComplete,
  isRetryableSshSetupError,
  setupAwareAgentStatus,
  setupPlanForRow,
  setupPlanLogLines,
} = await import("@/services/agent-setup");

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    organizationId: "org-1",
    repo: "https://example.com/org/my-app.git",
    projectName: "my-app",
    workspaceName: "my-app",
    accountId: "acct-1",
    pluginId: "hetzner",
    resourceTypeId: "server",
    tool: "codex",
    surface: "terminal",
    branchName: "infrawrench/agent-session1",
    status: "setting-up",
    vmResourceId: "vm-1",
    logs: [] as string[],
    setupPlanJson: "{}",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  selectResults.length = 0;
  updateSetCalls.length = 0;
  updateReturning.length = 0;
});

describe("hasAgentSetupComplete / setupAwareAgentStatus", () => {
  it("detects the completion log line", () => {
    expect(hasAgentSetupComplete([AGENT_SETUP_COMPLETE_LOG])).toBe(true);
    expect(hasAgentSetupComplete(["Provisioning VM."])).toBe(false);
    expect(hasAgentSetupComplete(null)).toBe(false);
    expect(hasAgentSetupComplete(undefined)).toBe(false);
  });

  it("keeps an up VM in setting-up until setup completes", () => {
    expect(setupAwareAgentStatus([], "up")).toBe("setting-up");
    expect(setupAwareAgentStatus([AGENT_SETUP_COMPLETE_LOG], "up")).toBe("up");
    expect(setupAwareAgentStatus([], "setting-up")).toBe("setting-up");
    expect(setupAwareAgentStatus([AGENT_SETUP_COMPLETE_LOG], "failed")).toBe("failed");
  });

  it("reports a set-up VM that is no longer running as stopped", () => {
    expect(setupAwareAgentStatus([AGENT_SETUP_COMPLETE_LOG], "setting-up")).toBe("stopped");
    expect(setupAwareAgentStatus([], "setting-up")).toBe("setting-up");
  });
});

describe("createAgentSetupPlanForRepo", () => {
  it("builds the git-url plan the desktop client produces for clone URLs", () => {
    const plan = createAgentSetupPlanForRepo(
      "https://example.com/org/my-app.git",
      "claude-code",
      "my-app",
    );
    expect(plan.source).toBe("git-url");
    expect(plan.initialCloneUrl).toBe("https://example.com/org/my-app.git");
    expect(plan.workspaceName).toBe("my-app");
    expect(plan.runtimes).toEqual([
      expect.objectContaining({ language: "node", version: "latest", versionSource: "latest" }),
    ]);
    expect(plan.runtimes[0]!.reasons[0]).toContain("Claude Code");
  });

  it("rejects local folder paths — web has no upload path", () => {
    expect(() => createAgentSetupPlanForRepo("/Users/me/repo", "codex", "repo")).toThrow(
      /cloneable Git URL/,
    );
  });
});

describe("setupPlanLogLines", () => {
  it("summarizes workspace, clone source, runtimes, and warnings", () => {
    const plan = createAgentSetupPlanForRepo("https://example.com/x.git", "codex", "x");
    const lines = setupPlanLogLines(plan);
    expect(lines[0]).toBe("Setup plan: workspace ~/x.");
    expect(lines).toContain("Setup plan: initial workspace pull from Git remote.");
    expect(lines).toContain("Setup plan: runtimes node latest (latest).");
    expect(lines.some((line) => line.startsWith("Setup plan warning:"))).toBe(true);
  });
});

describe("setupPlanForRow", () => {
  it("parses a persisted plan", () => {
    const plan = createAgentSetupPlanForRepo("https://example.com/x.git", "codex", "x");
    const row = sessionRow({ setupPlanJson: JSON.stringify(plan) });
    expect(setupPlanForRow(row)).toEqual(plan);
  });

  it("falls back to a fresh git-url plan for empty or invalid JSON", () => {
    for (const setupPlanJson of ["{}", "not-json"]) {
      const row = sessionRow({ setupPlanJson });
      const plan = setupPlanForRow(row);
      expect(plan.source).toBe("git-url");
      expect(plan.initialCloneUrl).toBe(row.repo);
      expect(plan.workspaceName).toBe(row.workspaceName);
    }
  });

  // A T3 Code server has no repo, so the repo-derived fallback would invent a
  // clone URL for a session that must never clone anything.
  it("falls back to a T3 Code plan for a t3-code session", () => {
    const row = sessionRow({ surface: "t3-code", repo: "", setupPlanJson: "not-json" });
    const plan = setupPlanForRow(row);
    expect(plan.initialCloneUrl).toBeUndefined();
    expect(plan.workspaceName).toBe(T3_CODE_PROJECTS_DIR);
    expect(plan.runtimes.map((runtime) => runtime.language)).toEqual(["node"]);
  });
});

describe("extractBootstrapWarning / isRetryableSshSetupError", () => {
  it("surfaces clone and workspace warnings from bootstrap stderr", () => {
    expect(
      extractBootstrapWarning("noise\ngit clone failed; created empty workspace at /home/x\n"),
    ).toContain("git clone failed");
    expect(extractBootstrapWarning("workspace is not a git repository: /home/x")).toContain(
      "workspace is not a git",
    );
    expect(extractBootstrapWarning("all good")).toBeNull();
  });

  it("classifies connection-shaped errors as retryable", () => {
    expect(isRetryableSshSetupError("SSH connection failed: connect ECONNREFUSED")).toBe(true);
    expect(isRetryableSshSetupError("Timed out while waiting for handshake")).toBe(true);
    expect(isRetryableSshSetupError("All configured authentication methods failed")).toBe(true);
    expect(isRetryableSshSetupError("Agent VM setup command failed with exit 1: boom")).toBe(false);
  });

  it("classifies dpkg/apt lock contention as retryable", () => {
    expect(
      isRetryableSshSetupError(
        "Agent VM setup command failed with exit 100: E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1452 (apt-get)",
      ),
    ).toBe(true);
    expect(
      isRetryableSshSetupError(
        "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?",
      ),
    ).toBe(true);
    expect(
      isRetryableSshSetupError(
        "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 903 (apt-get)",
      ),
    ).toBe(true);
  });

  it("classifies a timeout-killed bootstrap (exit 124) as retryable", () => {
    expect(isRetryableSshSetupError("Agent VM setup command failed with exit 124")).toBe(true);
    expect(isRetryableSshSetupError("Agent VM setup command failed with exit 1: boom")).toBe(false);
  });
});

describe("ensureAgentVmSetupForSession", () => {
  it("no-ops when setup already completed and forceSync is off", async () => {
    selectResults.push([sessionRow({ logs: [AGENT_SETUP_COMPLETE_LOG] })]);
    await expect(ensureAgentVmSetupForSession("session-1", "org-1")).resolves.toBeUndefined();
    expect(updateSetCalls).toHaveLength(0);
  });

  it("throws when the session does not exist", async () => {
    selectResults.push([]);
    await expect(ensureAgentVmSetupForSession("missing", "org-1")).rejects.toThrow(
      /Agent session not found/,
    );
  });

  it("records a Setup failed log line when setup errors", async () => {
    // 1: load session row
    selectResults.push([sessionRow()]);
    // 2: appendAgentSessionLog (started)
    selectResults.push([{ logs: [], status: "setting-up" }]);
    // 3: loadOrgAgentSshPrivateKey — no key row => setup fails
    selectResults.push([]);
    // 4: appendAgentSessionLog (Setup failed)
    selectResults.push([{ logs: ["Preparing VM for coding session."], status: "setting-up" }]);

    await expect(ensureAgentVmSetupForSession("session-1", "org-1")).rejects.toThrow(
      /Agent SSH key/,
    );
    // The lease release writes after the failure log, so find the log write
    // rather than assuming it is last.
    const logWrites = updateSetCalls.filter((c) => "logs" in c);
    const lastUpdate = logWrites[logWrites.length - 1]!;
    expect(lastUpdate.status).toBe("setting-up");
    expect(lastUpdate.logs).toEqual([
      "Preparing VM for coding session.",
      expect.stringMatching(/^Setup failed: Agent SSH key/),
    ]);
  });

  it("records a failure when the session has no VM", async () => {
    selectResults.push([sessionRow({ vmResourceId: null })]);
    selectResults.push([{ logs: [], status: "setting-up" }]);
    await expect(ensureAgentVmSetupForSession("session-1", "org-1")).rejects.toThrow(/has no VM/);
  });

  // The web deployment runs two replicas and `agentSetupInflight` only guards
  // one heap, so without a DB lease both pods set up the same VM at once.
  it("skips the run when another replica holds the setup lease", async () => {
    selectResults.push([sessionRow()]);
    updateReturning.push([]); // claim loses — no row came back
    await expect(ensureAgentVmSetupForSession("session-1", "org-1")).resolves.toBeUndefined();
    // The lease claim is the only write; setup itself never started, so no
    // "Preparing VM…" log line was appended.
    expect(updateSetCalls).toHaveLength(1);
    expect(updateSetCalls[0]).toHaveProperty("setupLeaseUntil");
    expect(updateSetCalls[0]!.setupLeaseUntil).toBeInstanceOf(Date);
  });

  it("releases the lease after a failed run so a retry can claim it", async () => {
    selectResults.push([sessionRow()]);
    selectResults.push([{ logs: [], status: "setting-up" }]);
    selectResults.push([]); // no SSH key row => setup fails
    selectResults.push([{ logs: ["Preparing VM for coding session."], status: "setting-up" }]);

    await expect(ensureAgentVmSetupForSession("session-1", "org-1")).rejects.toThrow(
      /Agent SSH key/,
    );
    const leaseWrites = updateSetCalls.filter((c) => "setupLeaseUntil" in c);
    expect(leaseWrites).toHaveLength(2);
    expect(leaseWrites[0]!.setupLeaseUntil).toBeInstanceOf(Date);
    expect(leaseWrites[1]!.setupLeaseUntil).toBeNull();
  });
});
