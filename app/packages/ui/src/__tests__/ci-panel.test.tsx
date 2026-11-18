import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  CI_DEFAULT_CONNECTION_ACCESS,
  type CiAccessOverview,
  type CiConnectionAccessSettings,
  type CiJobOutput,
  type CiResourceOutputs,
  type CiLogEvent,
  type CiRun,
  type CiStatus,
  type SearchResult,
} from "@infrawrench/client-core";

// gt-react's `gt` was not referentially stable until our patch (#1336): a
// fresh function on every render. The panel once listed it in its fetch
// effects' deps, which
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
const MANUAL_ID = "44444444-4444-4444-8444-444444444444";

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
    listSchedules: vi.fn(async () => ({
      schedules: [
        {
          installationId: 7,
          repoFullName: "acme/api",
          defaultBranch: "main",
          sha: "c".repeat(40),
          pipelines: [
            {
              file: ".infrawrench/ci/nightly.yml",
              name: "Nightly",
              cron: ["0 3 * * *"],
              nextRunAt: "2026-11-10T03:00:00.000Z",
            },
          ],
          refreshedAt: "2026-11-09T10:00:00.000Z",
          error: "other.yml: unknown key `whenn`",
        },
      ],
    })),
    listManual: vi.fn(async () => ({
      repositories: [
        {
          installationId: 7,
          repoFullName: "acme/web",
          defaultBranch: "main",
          sha: "d".repeat(40),
          refreshedAt: "2026-11-15T10:00:00.000Z",
          pipelines: [
            {
              file: ".infrawrench/ci/purge.yml",
              name: "Purge the CDN",
              inputs: [
                {
                  name: "urls",
                  type: "string" as const,
                  required: false,
                  description: "One URL per line",
                },
                {
                  name: "zone",
                  type: "choice" as const,
                  required: false,
                  default: "www",
                  options: ["www", "docs"],
                },
                { name: "dry-run", type: "boolean" as const, required: false },
                { name: "shards", type: "number" as const, required: false, default: "4" },
                { name: "reason", type: "string" as const, required: true },
              ],
            },
          ],
        },
      ],
    })),
    startRun: vi.fn(async () => ({
      ...run,
      id: MANUAL_ID,
      event: "manual" as const,
      status: "queued" as const,
      pullNumber: null,
      headRef: "main",
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
    access: vi.fn(async () => accessOverview()),
    setConnectionAccess: vi.fn(async (accountId: string, settings: CiConnectionAccessSettings) => ({
      ...accessOverview().connections[0]!,
      accountId,
      settings,
    })),
    preflightConnection: vi.fn(async () => ({
      ...accessOverview().connections[0]!,
      preflight: {
        vm: {
          ok: false,
          missing: [{ permission: "ec2:RunInstances", label: "Start the job's instance" }],
          problems: [],
          region: "eu-west-1",
          checkedAt: "2026-11-13T00:00:00.000Z",
        },
      },
    })),
    searchResources: vi.fn(async (): Promise<SearchResult[]> => []),
    resourceOutputs: vi.fn(async (): Promise<CiResourceOutputs> => ({
      outputs: [],
      secretVersions: null,
    })),
    createGrant: vi.fn(),
    updateGrant: vi.fn(),
    deleteGrant: vi.fn(async () => {}),
    revokeSshKeyLending: vi.fn(async () => {}),
    listAllRepos: vi.fn(async () => ["acme/web"]),
  };
}

function accessOverview(): CiAccessOverview {
  return {
    viewerUserId: "u1",
    connections: [
      {
        accountId: "acc-aws",
        accountName: "Production",
        pluginId: "aws",
        pluginName: "Amazon Web Services",
        executor: {
          kinds: [{ kind: "vm", label: "EC2 instance", defaults: { machine: "t3.large" } }],
          helpLink: { label: "Add these permissions", url: "https://example.test/iam" },
        },
        credential: null,
        settings: { ...CI_DEFAULT_CONNECTION_ACCESS },
        preflight: {},
        updatedAt: null,
      },
    ],
    grants: [],
    sshKeys: [],
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

function renderPanel(c: ReturnType<typeof client>, canManageAccess = true) {
  return render(
    <CiPanel
      client={c}
      selectedRunId={null}
      onSelectRun={() => {}}
      canWrite
      canManageAccess={canManageAccess}
      canApprove
    />,
  );
}

/** The AWS connection, running EC2 jobs on main and release branches. */
function runningJobs(): CiAccessOverview {
  const o = accessOverview();
  o.connections[0] = {
    ...o.connections[0]!,
    settings: {
      ...CI_DEFAULT_CONNECTION_ACCESS,
      jobsEnabled: true,
      jobKinds: ["vm"],
      jobBranchPattern: "main, release/*",
    },
    preflight: {
      vm: { ok: true, missing: [], problems: [], checkedAt: "2026-11-13T00:00:00.000Z" },
    },
  };
  o.connections.push({
    ...o.connections[0],
    accountId: "acc-off",
    accountName: "Staging",
    settings: { ...CI_DEFAULT_CONNECTION_ACCESS },
    preflight: {},
  });
  return o;
}

describe("CI access", () => {
  it("names what a connection lacks after its check, and keeps the kind off", async () => {
    const c = client();
    renderPanel(c);
    await waitFor(() => expect(screen.getByText("Manage connections")).toBeTruthy());
    // Nothing is on yet: the card says so instead of listing the connection.
    expect(screen.getByText("No connection runs jobs or lends its credentials yet.")).toBeTruthy();
    fireEvent.click(screen.getByText("Manage connections"));
    const dialog = await screen.findByRole("dialog", { name: "Manage connections" });
    expect(dialog.textContent).toContain("Production");
    // The kinds show only once jobs are switched on.
    expect(screen.queryByRole("button", { name: "Check permissions for EC2 instance" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Run jobs on it" }));
    fireEvent.click(screen.getByRole("button", { name: "Check permissions for EC2 instance" }));
    await waitFor(() => expect(screen.getByText("ec2:RunInstances")).toBeTruthy());
    expect(c.preflightConnection).toHaveBeenCalledWith("acc-aws", "vm");
    expect(screen.getByText("Not ready")).toBeTruthy();
    // The box can still be ticked: that checks again, and it stays off while the check fails.
    const kind = screen.getByRole("checkbox", { name: /EC2 instance/ }) as HTMLInputElement;
    expect(kind.disabled).toBe(false);
    fireEvent.click(kind);
    await waitFor(() => expect(c.preflightConnection).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(kind.disabled).toBe(false));
    expect(kind.checked).toBe(false);
  });

  it("lists only the connections that are on, in short, and saves one from the dialog", async () => {
    const c = client();
    c.access.mockImplementation(async () => runningJobs());
    renderPanel(c);
    const row = await screen.findByRole("button", { name: /Production/ });
    expect(row.textContent).toContain("Runs jobs");
    expect(row.textContent).toContain("EC2 instance");
    expect(row.textContent).toContain("All repositories · main, release/*");
    // Staging has nothing on, so it is only in the dialog.
    expect(screen.queryByText("Staging")).toBeNull();

    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Manage connections" });
    expect(dialog.textContent).toContain("Staging");
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Jobs at once"), { target: { value: "4" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(c.setConnectionAccess).toHaveBeenCalledWith(
      "acc-aws",
      expect.objectContaining({ jobsEnabled: true, jobKinds: ["vm"], maxConcurrentJobs: 4 }),
    );
    expect(save.disabled).toBe(true);
  });

  it("asks before closing the dialog over unsaved changes", async () => {
    const c = client();
    c.access.mockImplementation(async () => runningJobs());
    renderPanel(c);
    fireEvent.click(await screen.findByRole("button", { name: /Production/ }));
    await screen.findByRole("dialog", { name: "Manage connections" });
    fireEvent.change(screen.getByLabelText("Minutes per job"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
    fireEvent.click(screen.getByText("Discard"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(c.setConnectionAccess).not.toHaveBeenCalled();
  });

  it("grants a resource found by name, with its outputs that are not sensitive", async () => {
    const c = client();
    c.searchResources.mockImplementation(async () => [
      {
        id: "res-db",
        pluginId: "aws",
        pluginDisplayName: "Amazon Web Services",
        pluginLogoSvg: "",
        resourceTypeId: "aws-rds",
        resourceTypeLabel: "RDS database",
        accountId: "acc-aws",
        accountName: "Production",
        displayName: "prod-db",
      },
    ]);
    c.resourceOutputs.mockImplementation(async () => ({
      outputs: [
        { key: "host", label: "Host", sensitive: false },
        { key: "password", label: "Password", sensitive: true },
      ],
      secretVersions: null,
    }));
    c.createGrant.mockImplementation(async () => ({}));
    renderPanel(c);
    const search = await screen.findByPlaceholderText("Search for resources");
    // Nothing to grant until a resource is chosen.
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    fireEvent.change(search, { target: { value: "prod" } });
    fireEvent.click(await screen.findByRole("button", { name: /prod-db/ }));
    expect(c.searchResources).toHaveBeenCalledWith("prod");
    await waitFor(() => expect(screen.getByText("password")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Branches"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(c.createGrant).toHaveBeenCalledWith({
        resourceId: "res-db",
        ciName: "prod-db",
        outputs: ["host"],
        secretVersion: null,
        repos: null,
        branchPattern: "main",
      }),
    );
  });
  it("shows what a cluster lends before it is granted, and runs jobs on it without lending it", async () => {
    const c = client();
    c.searchResources.mockImplementation(async () => [
      {
        id: "res-gke",
        pluginId: "gcp",
        pluginDisplayName: "Google Cloud",
        pluginLogoSvg: "",
        resourceTypeId: "gke-cluster",
        resourceTypeLabel: "GKE cluster",
        accountId: "acc-gcp",
        accountName: "Infrawrench GCP",
        displayName: "prod-cluster",
      },
    ]);
    c.resourceOutputs.mockImplementation(async () => ({
      outputs: [{ key: "kubeconfig", label: "Kubeconfig", sensitive: true }],
      secretVersions: null,
      peers: [
        {
          pluginId: "kubernetes",
          pluginName: "Kubernetes",
          credential: { description: "A kubeconfig", shortLived: false, namespaces: true },
          executor: {
            kinds: [
              { kind: "cluster", label: "Kubernetes Job", defaults: {}, regionLabel: "Namespace" },
            ],
            helpLink: null,
          },
          lends: "A Google token minted for the run",
          reach: "Only the cluster",
          lifetime: "Up to seven hours",
          unavailable: null,
          unreachable: null,
        },
        {
          pluginId: "postgres",
          pluginName: "PostgreSQL",
          credential: { description: "DATABASE_URL", shortLived: false, namespaces: false },
          executor: null,
          lends: "x",
          reach: "x",
          lifetime: "x",
          unavailable: "Not with local accounts",
          unreachable: null,
        },
      ],
    }));
    c.createGrant.mockImplementation(async () => ({}));
    renderPanel(c);
    fireEvent.change(await screen.findByPlaceholderText("Search for resources"), {
      target: { value: "prod" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /prod-cluster/ }));
    const useAs = (await screen.findByLabelText(
      "Use it in CI as a connection",
    )) as HTMLSelectElement;
    // A peer its provider rules out is shown, with why, and cannot be chosen.
    expect(
      ([...useAs.options].find((o) => o.value === "postgres") as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Not with local accounts")).toBeTruthy();
    fireEvent.change(useAs, { target: { value: "kubernetes" } });
    // What it lends, before anything is switched on.
    expect(screen.getByText("A Google token minted for the run")).toBeTruthy();
    expect(screen.getByText("Only the cluster")).toBeTruthy();
    expect(screen.getByText("Up to seven hours")).toBeTruthy();
    const lend = screen.getByRole("checkbox", { name: /Lend it to jobs/ }) as HTMLInputElement;
    expect(lend.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Kubernetes Job/ }));
    fireEvent.change(screen.getByLabelText("Other places jobs may run (Namespace)"), {
      target: { value: "ci, staging" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(c.createGrant).toHaveBeenCalledWith({
        resourceId: "res-gke",
        ciName: "prod-cluster",
        outputs: [],
        secretVersion: null,
        repos: null,
        branchPattern: null,
        peer: {
          pluginId: "kubernetes",
          lend: false,
          jobKinds: ["cluster"],
          maxConcurrentJobs: 2,
          maxJobMinutes: 60,
          jobRegions: ["ci", "staging"],
        },
      }),
    );
  });
});

/** A ready check, as the server keeps it. */
const passed = {
  ok: true,
  missing: [],
  problems: [],
  checkedAt: "2026-11-15T00:00:00.000Z",
};

/** Google Cloud runs jobs but cannot lend; Kubernetes can do both. */
function gcpAndCluster(): CiAccessOverview {
  return {
    viewerUserId: "u1",
    connections: [
      {
        accountId: "acc-gcp",
        accountName: "Infrawrench GCP",
        pluginId: "gcp",
        pluginName: "Google Cloud",
        executor: {
          kinds: [
            { kind: "vm", label: "Compute Engine instance", defaults: {} },
            { kind: "container", label: "Cloud Run job", defaults: {} },
          ],
          helpLink: null,
        },
        credential: null,
        settings: { ...CI_DEFAULT_CONNECTION_ACCESS },
        preflight: {},
        updatedAt: null,
      },
      {
        accountId: "acc-k8s",
        accountName: "Cluster",
        pluginId: "kubernetes",
        pluginName: "Kubernetes",
        executor: null,
        credential: { description: "A kubeconfig.", shortLived: false, namespaces: true },
        settings: { ...CI_DEFAULT_CONNECTION_ACCESS },
        preflight: {},
        updatedAt: null,
      },
    ],
    grants: [],
    sshKeys: [],
  };
}

async function openDialog(c: ReturnType<typeof client>, overview: () => CiAccessOverview) {
  c.access.mockImplementation(async () => overview());
  renderPanel(c);
  fireEvent.click(await screen.findByText("Manage connections"));
  return screen.findByRole("dialog", { name: "Manage connections" });
}

const saveButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;

describe("CI connections dialog", () => {
  it("keeps Save off, and says why, while running jobs has no kind", async () => {
    const c = client();
    const dialog = await openDialog(c, gcpAndCluster);
    fireEvent.click(within(dialog).getByRole("switch", { name: "Run jobs on it" }));
    const save = saveButton(dialog);
    expect(save.disabled).toBe(true);
    // Beside the kinds and beside Save.
    expect(within(dialog).getAllByText("Choose at least one kind of job.")).toHaveLength(2);
    expect(within(dialog).getAllByText("Not checked")).toHaveLength(2);
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((b) => !b.disabled)).toBe(true);
    expect(c.setConnectionAccess).not.toHaveBeenCalled();
  });

  it("checks a kind when it is ticked, ticks it once the check passes, and saves", async () => {
    const c = client();
    c.preflightConnection.mockImplementation(async () => ({
      ...gcpAndCluster().connections[0]!,
      preflight: { vm: { ...passed, region: "us-central1" } },
    }));
    const dialog = await openDialog(c, gcpAndCluster);
    fireEvent.click(within(dialog).getByRole("switch", { name: "Run jobs on it" }));
    const vm = within(dialog).getByRole("checkbox", {
      name: /Compute Engine instance/,
    }) as HTMLInputElement;
    fireEvent.click(vm);
    expect(c.preflightConnection).toHaveBeenCalledWith("acc-gcp", "vm");
    await waitFor(() => expect(within(dialog).getByText("Ready")).toBeTruthy());
    expect(vm.checked).toBe(true);
    const save = saveButton(dialog);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(within(dialog).getByText("Saved")).toBeTruthy());
    expect(c.setConnectionAccess).toHaveBeenCalledWith(
      "acc-gcp",
      expect.objectContaining({ jobsEnabled: true, jobKinds: ["vm"] }),
    );
  });

  it("shows the server's refusal beside Save", async () => {
    const c = client();
    c.setConnectionAccess.mockImplementation(async () => {
      throw new Error("Kubernetes connections cannot be lent to jobs.");
    });
    const dialog = await openDialog(c, gcpAndCluster);
    fireEvent.click(within(dialog).getByRole("button", { name: /Cluster/ }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Lend its credentials to jobs" }));
    fireEvent.click(saveButton(dialog));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Kubernetes connections cannot be lent to jobs.");
  });

  it("says the save failed when the failure has no message", async () => {
    const c = client();
    c.setConnectionAccess.mockImplementation(async () => {
      throw new Error("");
    });
    const dialog = await openDialog(c, gcpAndCluster);
    fireEvent.click(within(dialog).getByRole("button", { name: /Cluster/ }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Lend its credentials to jobs" }));
    fireEvent.click(saveButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Could not save");
  });

  it("saves lending alone, with running jobs off", async () => {
    const c = client();
    const dialog = await openDialog(c, gcpAndCluster);
    fireEvent.click(within(dialog).getByRole("button", { name: /Cluster/ }));
    // Kubernetes here runs no jobs: said, with no switch.
    expect(within(dialog).getByText("Kubernetes connections can't run jobs.")).toBeTruthy();
    expect(within(dialog).queryByRole("switch", { name: "Run jobs on it" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Lend its credentials to jobs" }));
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(within(dialog).getByText("Saved")).toBeTruthy());
    expect(c.setConnectionAccess).toHaveBeenCalledWith(
      "acc-k8s",
      expect.objectContaining({ jobsEnabled: false, lendEnabled: true }),
    );
  });

  it("says a provider cannot lend, and lets lending that is on anyway be turned off", async () => {
    const c = client();
    const lentAnyway = () => {
      const o = gcpAndCluster();
      o.connections[0] = {
        ...o.connections[0]!,
        settings: { ...CI_DEFAULT_CONNECTION_ACCESS, lendEnabled: true },
      };
      return o;
    };
    c.preflightConnection.mockImplementation(async () => ({
      ...lentAnyway().connections[0]!,
      preflight: { vm: { ...passed, region: "us-central1" } },
    }));
    const dialog = await openDialog(c, lentAnyway);
    expect(
      within(dialog).getByText("Google Cloud connections can't be lent to jobs."),
    ).toBeTruthy();
    const lend = within(dialog).getByRole("switch", { name: "Lend its credentials to jobs" });
    expect(lend.getAttribute("aria-checked")).toBe("true");
    // Any other change cannot be saved while it is on, since the server would refuse it.
    fireEvent.click(within(dialog).getByRole("switch", { name: "Run jobs on it" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Compute Engine instance/ }));
    await waitFor(() =>
      expect(
        within(dialog).getByText(
          "Google Cloud connections can't be lent to jobs. Turn lending off.",
        ),
      ).toBeTruthy(),
    );
    const save = saveButton(dialog);
    expect(save.disabled).toBe(true);
    fireEvent.click(lend);
    expect(
      within(dialog).queryByRole("switch", { name: "Lend its credentials to jobs" }),
    ).toBeNull();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(c.setConnectionAccess).toHaveBeenCalledWith(
        "acc-gcp",
        expect.objectContaining({ jobsEnabled: true, jobKinds: ["vm"], lendEnabled: false }),
      ),
    );
  });
});

describe("CI access without ci-access:write", () => {
  it("shows the connections but offers no change, even with ci:write", async () => {
    const c = client();
    c.access.mockImplementation(async () => runningJobs());
    renderPanel(c, false);
    await waitFor(() => expect(screen.getByText("Production")).toBeTruthy());
    expect(screen.queryByPlaceholderText("Search for resources")).toBeNull();
    fireEvent.click(screen.getByText("View connections"));
    const dialog = await screen.findByRole("dialog", { name: "Manage connections" });
    expect(within(dialog).getByText(/Read only/)).toBeTruthy();
    const check = screen.getByRole("button", { name: "Check permissions for EC2 instance" });
    expect(check.closest("fieldset")?.disabled).toBe(true);
    expect(
      screen.getByRole("switch", { name: "Run jobs on it" }).closest("fieldset")?.disabled,
    ).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
  });
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
    expect(c.listSchedules).toHaveBeenCalledTimes(1);
  });

  it("lists scheduled pipelines and labels a scheduled run", async () => {
    const c = client();
    c.listRuns.mockResolvedValue([
      {
        ...run,
        event: "schedule",
        headRef: "main",
        pullNumber: null,
        pipelineFile: ".infrawrench/ci/nightly.yml",
      },
    ]);
    render(<CiPanel client={c} selectedRunId={null} onSelectRun={() => {}} canWrite canApprove />);
    await waitFor(() => expect(screen.getByText("acme/api on main")).toBeTruthy());
    expect(screen.getByText("Nightly")).toBeTruthy();
    expect(screen.getByText("0 3 * * *")).toBeTruthy();
    expect(screen.getByText("The last read failed: other.yml: unknown key `whenn`")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("Scheduled .infrawrench/ci/nightly.yml on main")).toBeTruthy(),
    );
  });

  it("starts a manual pipeline from a form built from its inputs, and opens the run", async () => {
    const c = client();
    const onSelectRun = vi.fn();
    render(
      <CiPanel client={c} selectedRunId={null} onSelectRun={onSelectRun} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("Purge the CDN")).toBeTruthy());
    const card = screen.getByRole("region", { name: "Manual runs" });
    fireEvent.click(within(card).getByRole("button", { name: "Run" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("One URL per line")).toBeTruthy();
    expect((within(dialog).getByLabelText("Branch") as HTMLInputElement).value).toBe("main");
    expect((within(dialog).getByLabelText(/zone/) as HTMLSelectElement).value).toBe("www");
    expect((within(dialog).getByLabelText(/shards/) as HTMLInputElement).value).toBe("4");

    // A required input left empty, and a number that is not one, stop it.
    fireEvent.change(within(dialog).getByLabelText(/shards/), { target: { value: "lots" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(within(dialog).getByText("Required")).toBeTruthy());
    expect(within(dialog).getByText("A number")).toBeTruthy();
    expect(c.startRun).not.toHaveBeenCalled();

    // A value a shell would run is sent as typed; defaults left alone are
    // not sent, so the branch's own file decides them.
    const hostile = "$(touch /tmp/pwned)\n'; rm -rf / #";
    fireEvent.change(within(dialog).getByLabelText(/shards/), { target: { value: "4" } });
    fireEvent.change(within(dialog).getByLabelText(/reason/), { target: { value: "release" } });
    fireEvent.change(within(dialog).getByLabelText(/urls/), { target: { value: hostile } });
    fireEvent.click(within(dialog).getByLabelText("dry-run"));
    fireEvent.change(within(dialog).getByLabelText("Branch"), { target: { value: "feature/x" } });
    expect(
      within(dialog).getByText(
        "The inputs below are main's. The run checks them against feature/x's own pipeline file.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(onSelectRun).toHaveBeenCalledWith(MANUAL_ID));
    expect(c.startRun).toHaveBeenCalledWith({
      installationId: 7,
      repoFullName: "acme/web",
      pipelineFile: ".infrawrench/ci/purge.yml",
      branch: "feature/x",
      inputs: { urls: hostile, "dry-run": true, reason: "release" },
    });
  });

  it("shows the server's refusal in the form, and offers no start without ci:approve", async () => {
    const c = client();
    c.startRun.mockRejectedValueOnce(new Error("acme/web has no branch nope."));
    const { unmount } = render(
      <CiPanel client={c} selectedRunId={null} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("Purge the CDN")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/reason/), { target: { value: "x" } });
    fireEvent.change(within(dialog).getByLabelText("Branch"), { target: { value: "nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() =>
      expect(within(dialog).getByText("acme/web has no branch nope.")).toBeTruthy(),
    );
    unmount();

    render(
      <CiPanel
        client={c}
        selectedRunId={null}
        onSelectRun={() => {}}
        canWrite
        canApprove={false}
      />,
    );
    await waitFor(() => expect(screen.getByText("Purge the CDN")).toBeTruthy());
    const button = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Starting a run takes permission to approve CI runs.");
  });

  it("labels a manual run and lists the inputs it was started with", async () => {
    const c = client();
    const manualRun: CiRun = {
      ...run,
      event: "manual",
      headRef: "feature/x",
      pullNumber: null,
      actorLogin: "someone@example.com",
      pipelineFile: ".infrawrench/ci/purge.yml",
      inputs: { zone: "docs", urls: "a\nb" },
    };
    c.listRuns.mockResolvedValue([manualRun]);
    c.getRun.mockResolvedValue({ run: manualRun, jobs: [] });
    const { unmount } = render(
      <CiPanel client={c} selectedRunId={null} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Started by hand: .infrawrench/ci/purge.yml on feature/x"),
      ).toBeTruthy(),
    );
    unmount();
    render(
      <CiPanel client={c} selectedRunId={run.id} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("zone")).toBeTruthy());
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.getByText("Started by someone@example.com")).toBeTruthy();
  });

  it("lists runs with nothing to run only when asked for, and says why on the run", async () => {
    const skipped: CiRun = {
      ...run,
      id: "33333333-3333-4333-8333-333333333333",
      status: "skipped",
      statusReason: "No pipeline runs on this push.",
      startedAt: null,
      jobs: [],
    };
    const c = client();
    c.listRuns.mockImplementation(async (status?: string) =>
      status === "skipped" ? [skipped] : [run],
    );
    const { unmount } = render(
      <CiPanel client={c} selectedRunId={null} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("aaaaaaa")).toBeTruthy());
    expect(c.listRuns).toHaveBeenLastCalledWith(undefined);
    fireEvent.change(screen.getByRole("combobox", { name: /Show/ }), {
      target: { value: "skipped" },
    });
    await waitFor(() => expect(c.listRuns).toHaveBeenLastCalledWith("skipped"));
    await waitFor(() => expect(screen.getAllByText("Nothing to run").length).toBeGreaterThan(1));
    unmount();
    c.getRun.mockResolvedValue({ run: skipped, jobs: null });
    render(
      <CiPanel client={c} selectedRunId={skipped.id} onSelectRun={() => {}} canWrite canApprove />,
    );
    await waitFor(() => expect(screen.getByText("No pipeline runs on this push.")).toBeTruthy());
    expect(screen.queryByText("No pipeline ran for this event.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
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
    // The run reads as cancelling only once it was cancelled: a refetch
    // before the click (the live log ending, say) must not take the button.
    let cancelled = false;
    c.getRun.mockImplementation(async () => ({
      run: cancelled ? { ...running, cancelRequested: true } : running,
      jobs: null,
    }));
    const cancel = c.cancelRun.getMockImplementation()!;
    c.cancelRun.mockImplementation(async (id: string) => {
      cancelled = true;
      return cancel(id);
    });
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
