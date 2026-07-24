import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsPanel } from "../agents/AgentsPanel.js";
import type { AgentClient, AgentSession, AgentSettings, AgentVmAccount } from "../agents/types.js";
import { useUIStore } from "../store/ui.store.js";

const googleCloudLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Google Cloud</title><path d="M0 0h100v100H0z"/></svg>`;

function makeClient(
  account: AgentVmAccount | AgentVmAccount[],
  settings: AgentSettings | null = null,
  overrides: Partial<AgentClient> = {},
): AgentClient {
  const accounts = Array.isArray(account) ? account : [account];
  return {
    listAccounts: vi.fn(async () => accounts),
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (next) => next),
    listSessions: vi.fn(async () => [] as AgentSession[]),
    createSession: vi.fn(async (body) => ({
      id: "session-1",
      repo: body.repo,
      projectName: body.projectName ?? "project",
      workspaceName: body.workspaceName ?? body.projectName ?? "project",
      accountId: body.settings.accountId,
      pluginId: body.settings.pluginId,
      resourceTypeId: body.settings.resourceTypeId,
      tool: body.settings.tool,
      branchName: "infrawrench/agent-session",
      status: "provisioning" as const,
      logs: [],
    })),
    openSession: vi.fn(),
    reconcileSession: vi.fn(),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("AgentsPanel", () => {
  beforeEach(() => {
    useUIStore.setState({ workspaceTabs: [], activeWorkspaceTabId: null });
  });

  it("renders provider logos and human labels for agent defaults", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "Workspace",
      pluginId: "gcp",
      pluginName: "Google Cloud",
      pluginLogoSvg: googleCloudLogo,
      resourceTypeId: "gce-instance",
      resourceTypeName: "VM Instance",
      defaultUsername: "ubuntu",
      defaultFields: {
        image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
        machineType: "e2-standard-2",
        diskGb: "40",
      },
      defaultFieldLabels: {
        image: "OS image",
        machineType: "Machine type",
        diskGb: "Boot disk size",
      },
      createFields: [
        {
          key: "image",
          label: "OS Image",
          kind: "image-picker",
          required: true,
          images: [
            {
              id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
              label: "Ubuntu 24.04 LTS",
              category: "Ubuntu",
            },
          ],
        },
        {
          key: "machineType",
          label: "Machine Type",
          kind: "size-picker",
          required: true,
          sizes: [
            {
              id: "e2-standard-2",
              label: "e2-standard-2",
              vcpus: 2,
              memoryMb: 8192,
              category: "E2",
            },
          ],
        },
        {
          key: "diskGb",
          label: "Boot Disk Size",
          kind: "disk-slider",
          required: false,
          minGb: 10,
          maxGb: 2000,
          stepGb: 10,
          defaultGb: 40,
        },
      ],
      hiddenFieldKeys: [],
    };
    const { container } = render(<AgentsPanel client={makeClient(account)} />);

    expect(await screen.findByText("Workspace (Google Cloud)")).toBeInTheDocument();
    expect(container.querySelector("svg title")?.textContent).toBe("Google Cloud");
    expect(screen.queryByText("GC")).not.toBeInTheDocument();

    screen.getByRole("button", { name: /Workspace \(Google Cloud\)/ }).click();
    expect(await screen.findByText("OS image")).toBeInTheDocument();
    expect(await screen.findByText("Machine type")).toBeInTheDocument();
    expect(screen.getByText("Boot disk size")).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Images" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /e2-standard-2/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("slider")).toHaveValue("40");
    expect(screen.queryByText("machineType")).not.toBeInTheDocument();
    expect(screen.queryByText("diskGb")).not.toBeInTheDocument();
  });

  it("sorts accounts alphabetically by display label", async () => {
    const baseAccount: AgentVmAccount = {
      accountId: "acct-zeta",
      accountName: "Zeta",
      pluginId: "aws",
      pluginName: "Amazon Web Services",
      resourceTypeId: "ec2-instance",
      resourceTypeName: "EC2 Instance",
      defaultUsername: "ubuntu",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    render(
      <AgentsPanel
        client={makeClient([
          baseAccount,
          {
            ...baseAccount,
            accountId: "acct-alpha",
            accountName: "Alpha",
            pluginId: "gcp",
            pluginName: "Google Cloud",
          },
          { ...baseAccount, accountId: "acct-bravo", accountName: "Bravo" },
          { ...baseAccount, accountId: "acct-charlie", accountName: "Charlie" },
          { ...baseAccount, accountId: "acct-delta", accountName: "Delta" },
        ])}
      />,
    );

    expect(await screen.findByText("Alpha (Google Cloud)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Alpha \(Google Cloud\)/ }));
    await screen.findByRole("option", { name: /Alpha \(Google Cloud\)/ });
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([
      "Alpha (Google Cloud)acct-alpha:gcp:ec2-instance",
      "Bravo (Amazon Web Services)acct-bravo:aws:ec2-instance",
      "Charlie (Amazon Web Services)acct-charlie:aws:ec2-instance",
      "Delta (Amazon Web Services)acct-delta:aws:ec2-instance",
      "Zeta (Amazon Web Services)acct-zeta:aws:ec2-instance",
    ]);
  });

  it("adds newly introduced provider default fields to stale saved settings", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      // "region" exists in current defaults but not in the saved settings.
      defaultFields: { region: "nyc3", size: "s-2vcpu-4gb", image: "ubuntu-24-04-x64" },
      defaultFieldLabels: { region: "Region", size: "Size", image: "Image" },
      hiddenFieldKeys: [],
    };
    const savedBeforeRegionExisted: AgentSettings = {
      accountId: "acct-1",
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      tool: "codex",
      fields: { size: "s-4vcpu-8gb", image: "ubuntu-24-04-x64", legacyKey: "stale" },
    };
    render(<AgentsPanel client={makeClient(account, savedBeforeRegionExisted)} />);

    await screen.findByText("test (DigitalOcean)");
    fireEvent.click(screen.getByRole("button", { name: /test \(DigitalOcean\)/ }));

    // The new default appears, the user's saved value survives, stale keys drop.
    expect(await screen.findByText("Region")).toBeInTheDocument();
    expect(screen.getByDisplayValue("nyc3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("s-4vcpu-8gb")).toBeInTheDocument();
    expect(screen.queryByText("Legacy key")).not.toBeInTheDocument();
  });

  it("saves the selected account when it changes", async () => {
    const baseAccount: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "Zeta",
      pluginId: "aws",
      pluginName: "Amazon Web Services",
      resourceTypeId: "ec2-instance",
      resourceTypeName: "EC2 Instance",
      defaultUsername: "ubuntu",
      defaultFields: { instanceType: "t3.small" },
      hiddenFieldKeys: [],
    };
    const client = makeClient([
      baseAccount,
      {
        ...baseAccount,
        accountId: "acct-2",
        accountName: "Alpha",
        pluginId: "gcp",
        pluginName: "Google Cloud",
        defaultFields: { machineType: "e2-standard-2" },
      },
    ]);
    render(<AgentsPanel client={client} />);

    expect(await screen.findByText("Alpha (Google Cloud)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Alpha \(Google Cloud\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Zeta (Amazon Web Services)" }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalledTimes(1));
    expect(client.saveSettings).toHaveBeenCalledWith({
      accountId: "acct-1",
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      tool: "codex",
      fields: { instanceType: "t3.small" },
    });
  });

  it("can browse for a local repository path when the host supports it", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "Workspace",
      pluginId: "gcp",
      pluginName: "Google Cloud",
      resourceTypeId: "gce-instance",
      resourceTypeName: "VM Instance",
      defaultUsername: "ubuntu",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account, null, {
      pickLocalRepoPath: vi.fn(async () => "/Users/astrid/src/infrawrench"),
    });
    render(<AgentsPanel client={client} />);

    await screen.findByText("Workspace (Google Cloud)");
    fireEvent.click(screen.getByRole("button", { name: "Local folder" }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText("/path/to/local/repo")).toHaveValue(
        "/Users/astrid/src/infrawrench",
      ),
    );
    fireEvent.change(screen.getByPlaceholderText("Agent name"), {
      target: { value: "docs-agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(1));
    expect(client.createSession).toHaveBeenCalledWith({
      repo: "/Users/astrid/src/infrawrench",
      projectName: "docs-agent",
      workspaceName: "infrawrench",
      settings: {
        accountId: "acct-1",
        pluginId: "gcp",
        resourceTypeId: "gce-instance",
        tool: "codex",
        fields: {},
      },
    });
  });

  it("shows human session status labels", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "Workspace",
      pluginId: "gcp",
      pluginName: "Google Cloud",
      resourceTypeId: "gce-instance",
      resourceTypeName: "VM Instance",
      defaultUsername: "ubuntu",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account);
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "https://github.com/acme/app.git",
        projectName: "build-agent",
        workspaceName: "app",
        accountId: "acct-1",
        pluginId: "gcp",
        resourceTypeId: "gce-instance",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "up",
        vmResourceId: "acct-1:gce-instance:vm-1",
        logs: [],
      },
    ]);
    render(<AgentsPanel client={client} />);

    expect(await screen.findByText("build-agent")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("up")).not.toBeInTheDocument();
  });

  it("hides the Open button while a session is still setting up", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account);
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "https://github.com/acme/app.git",
        projectName: "build-agent",
        workspaceName: "app",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "setting-up",
        vmResourceId: "acct-1:droplet:123",
        logs: [],
      },
    ]);
    render(<AgentsPanel client={client} />);

    expect(await screen.findByText("build-agent")).toBeInTheDocument();
    expect(screen.getByText("Setting up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconcile" })).not.toBeInTheDocument();
  });

  it("offers Retry setup when a setting-up session's setup failed", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account, null, {
      openSession: vi.fn(async () => ({
        command: "codex",
        cwd: "~/app",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
      })),
    });
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "https://github.com/acme/app.git",
        projectName: "build-agent",
        workspaceName: "app",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "setting-up",
        vmResourceId: "acct-1:droplet:123",
        logs: [
          "Installing system packages.",
          "Setup failed: Agent VM setup command failed with exit 100: E: Could not get lock /var/lib/dpkg/lock-frontend",
        ],
      },
    ]);
    render(<AgentsPanel client={client} />);

    expect(await screen.findByText("build-agent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));

    await waitFor(() => expect(client.openSession).toHaveBeenCalledWith("session-1"));
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(workspaceTabs[0]!.target).toMatchObject({
      kind: "resource",
      resourceId: "acct-1:droplet:123",
      view: "ssh",
      agentSessionId: "session-1",
    });
  });

  it("shows Open and Reconcile once a session is ready", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account);
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "https://github.com/acme/app.git",
        projectName: "build-agent",
        workspaceName: "app",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "up",
        vmResourceId: "acct-1:droplet:123",
        logs: [],
      },
    ]);
    render(<AgentsPanel client={client} />);

    expect(await screen.findByText("build-agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeInTheDocument();
  });

  it("opens a ready agent in an SSH workspace tab with its tool command", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account, null, {
      openSession: vi.fn(async () => ({
        command: "codex",
        cwd: "~/infrawrench",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
      })),
    });
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "/Users/astrid/infrawrench",
        projectName: "test",
        workspaceName: "infrawrench",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "up",
        vmResourceId: "acct-1:droplet:123",
        logs: [],
      },
    ]);
    render(<AgentsPanel client={client} />);

    await screen.findByText("test");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(client.openSession).toHaveBeenCalledWith("session-1"));
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(activeWorkspaceTabId).toBe(workspaceTabs[0]!.id);
    expect(workspaceTabs[0]!.title).toBe("codex · test");
    expect(workspaceTabs[0]!.target).toMatchObject({
      kind: "resource",
      accountId: "acct-1",
      resourceId: "acct-1:droplet:123",
      view: "ssh",
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
      initialCommand: "codex",
      initialCwd: "~/infrawrench",
    });
  });

  it("replaces a stale plain SSH tab for the same VM when opening an agent", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account, null, {
      openSession: vi.fn(async () => ({
        command: "codex",
        cwd: "~/infrawrench",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
      })),
    });
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "/Users/astrid/infrawrench",
        projectName: "test",
        workspaceName: "infrawrench",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "up",
        vmResourceId: "acct-1:droplet:123",
        logs: [],
      },
    ]);
    useUIStore.getState().pinWorkspaceTab(
      {
        kind: "resource",
        accountId: "acct-1",
        resourceId: "acct-1:droplet:123",
        view: "ssh",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
      },
      "SSH: test",
    );

    render(<AgentsPanel client={client} />);

    await screen.findByText("test");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(client.openSession).toHaveBeenCalledWith("session-1"));
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(activeWorkspaceTabId).toBe(workspaceTabs[0]!.id);
    expect(workspaceTabs[0]!.title).toBe("codex · test");
    expect(workspaceTabs[0]!.target).toMatchObject({
      kind: "resource",
      accountId: "acct-1",
      resourceId: "acct-1:droplet:123",
      view: "ssh",
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      sshKeyName: "infrawrench-agent",
      initialCommand: "codex",
      initialCwd: "~/infrawrench",
    });
  });

  it("replaces an existing agent SSH tab for the same VM when opening again", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account, null, {
      openSession: vi.fn(async () => ({
        command: "bash -lc 'screen -D -r infrawrench-agent'",
        cwd: "~/infrawrench",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
      })),
    });
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "/Users/astrid/infrawrench",
        projectName: "test",
        workspaceName: "infrawrench",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "up",
        vmResourceId: "acct-1:droplet:123",
        logs: [],
      },
    ]);
    useUIStore.getState().pinWorkspaceTab(
      {
        kind: "resource",
        accountId: "acct-1",
        resourceId: "acct-1:droplet:123",
        view: "ssh",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        agentSessionId: "session-1",
        sshKeyId: "agent-key-1",
        sshKeyName: "infrawrench-agent",
        initialCommand: "codex",
        initialCwd: "~/infrawrench",
      },
      "codex · test",
    );

    render(<AgentsPanel client={client} />);

    await screen.findByText("test");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(client.openSession).toHaveBeenCalledWith("session-1"));
    const { workspaceTabs } = useUIStore.getState();
    expect(workspaceTabs).toHaveLength(1);
    expect(workspaceTabs[0]!.target).toMatchObject({
      kind: "resource",
      accountId: "acct-1",
      resourceId: "acct-1:droplet:123",
      view: "ssh",
      agentSessionId: "session-1",
      sshKeyId: "agent-key-1",
      initialCommand: "bash -lc 'screen -D -r infrawrench-agent'",
    });
  });

  it("deletes a session after confirmation and removes its row", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account);
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "/Users/astrid/infrawrench",
        projectName: "doomed-agent",
        workspaceName: "infrawrench",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "up",
        vmResourceId: "acct-1:droplet:123",
        logs: [],
      },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AgentsPanel client={client} />);

    await screen.findByText("doomed-agent");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(client.deleteSession).toHaveBeenCalledWith("session-1"));
    await waitFor(() => expect(screen.queryByText("doomed-agent")).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it("does not delete when the confirmation is declined", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account);
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "/Users/astrid/infrawrench",
        projectName: "kept-agent",
        workspaceName: "infrawrench",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "up",
        vmResourceId: "acct-1:droplet:123",
        logs: [],
      },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AgentsPanel client={client} />);

    await screen.findByText("kept-agent");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("kept-agent")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("creates a session from a GitHub repo picked through the git integration", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "Workspace",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account);
    render(
      <AgentsPanel
        client={client}
        gitIntegration={{
          configured: true,
          repos: [
            { installationId: 7, fullName: "acme/app", defaultBranch: "main", private: true },
            { installationId: 7, fullName: "acme/site", defaultBranch: "main" },
          ],
          onConnect: vi.fn(),
        }}
      />,
    );

    await screen.findByText("Workspace (DigitalOcean)");
    // The picker replaces the free-text URL input until Custom is chosen.
    expect(screen.queryByPlaceholderText("https://github.com/org/repo.git")).toBeNull();
    const picker = screen.getByRole("combobox", { name: "Repository" });
    expect(
      Array.from((picker as HTMLSelectElement).options).map((option) => option.textContent),
    ).toEqual(["Select a repository…", "acme/app (private)", "acme/site", "Custom Git URL…"]);

    fireEvent.change(picker, { target: { value: "acme/app" } });
    fireEvent.change(screen.getByPlaceholderText("Agent name"), {
      target: { value: "app-agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(1));
    expect(client.createSession).toHaveBeenCalledWith({
      repo: "https://github.com/acme/app.git",
      projectName: "app-agent",
      workspaceName: "app",
      settings: {
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        fields: {},
      },
    });
  });

  it("falls back to a free-text URL when Custom Git URL is picked", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "Workspace",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    render(
      <AgentsPanel
        client={makeClient(account)}
        gitIntegration={{
          configured: true,
          repos: [{ installationId: 7, fullName: "acme/app", defaultBranch: "main" }],
          onConnect: vi.fn(),
        }}
      />,
    );

    await screen.findByText("Workspace (DigitalOcean)");
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), {
      target: { value: "custom" },
    });
    const urlInput = await screen.findByPlaceholderText("https://github.com/org/repo.git");
    fireEvent.change(urlInput, { target: { value: "https://gitlab.com/acme/app.git" } });
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveValue("custom");
  });

  it("offers Connect GitHub when the integration is configured without repos", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "Workspace",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const onConnect = vi.fn();
    render(
      <AgentsPanel
        client={makeClient(account)}
        gitIntegration={{ configured: true, repos: [], onConnect }}
      />,
    );

    await screen.findByText("Workspace (DigitalOcean)");
    // The free-text URL input stays available alongside the connect button.
    expect(screen.getByPlaceholderText("https://github.com/org/repo.git")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("hides sessions that do not have a backing VM", async () => {
    const account: AgentVmAccount = {
      accountId: "acct-1",
      accountName: "test",
      pluginId: "digitalocean",
      pluginName: "DigitalOcean",
      resourceTypeId: "droplet",
      resourceTypeName: "Droplet",
      defaultUsername: "root",
      defaultFields: {},
      hiddenFieldKeys: [],
    };
    const client = makeClient(account);
    vi.mocked(client.listSessions).mockResolvedValue([
      {
        id: "session-1",
        repo: "/Users/astrid/infrawrench",
        projectName: "infrawrench",
        workspaceName: "infrawrench",
        accountId: "acct-1",
        pluginId: "digitalocean",
        resourceTypeId: "droplet",
        tool: "codex",
        branchName: "infrawrench/agent-session",
        status: "pending",
        vmResourceId: null,
        logs: ["Agent session recorded."],
      },
    ]);
    render(<AgentsPanel client={client} />);

    expect(await screen.findByText("No agent VMs yet.")).toBeInTheDocument();
    expect(screen.queryByText("infrawrench")).not.toBeInTheDocument();
    expect(screen.queryByText(/test \(DigitalOcean\) · VM/)).not.toBeInTheDocument();
  });
});
