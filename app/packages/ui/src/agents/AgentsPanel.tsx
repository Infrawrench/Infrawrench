import { useEffect, useMemo, useRef, useState } from "react";
import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import { FieldRenderer } from "../components/create-resource/FieldRenderer.js";
import { AGENT_SETUP_FAILED_LOG_PREFIX } from "./launch-command.js";
import { closeSshTabsForAgentTarget, openAgentSshTerminalTab } from "./open-ssh-tab.js";
import {
  agentSurfaceOrDefault,
  agentSurfaceRequiresRepo,
  isT3CodeSurface,
  T3_CODE_PROJECTS_DIR,
} from "./t3-code.js";
import { resourceSshTabTarget } from "../workspace-tabs.js";
import { useUIStore } from "../store/ui.store.js";
import type { GitIntegration, GitRepoOption } from "../workflows/types.js";
import type {
  AgentClient,
  AgentSession,
  AgentSettings,
  AgentSurface,
  AgentTool,
  AgentVmAccount,
} from "./types.js";

type RepoSource = "git-url" | "local-path";

interface AgentsPanelProps {
  client: AgentClient;
  openWorkspaceTarget?: (target: ReturnType<typeof resourceSshTabTarget>, title: string) => void;
  /**
   * GitHub App integration for picking a session repo from the org's
   * connected installations (same surface the Workflows git triggers use).
   * Absent on hosts without the integration (desktop), where the Git URL
   * stays a free-text input.
   */
  gitIntegration?: GitIntegration;
}

function statusClass(status: AgentSession["status"]): string {
  if (status === "up") return "bg-green-500";
  if (status === "failed") return "bg-red-500";
  if (status === "stopped") return "bg-surface-sunken";
  return "bg-yellow-500";
}

function statusLabel(status: AgentSession["status"]): string {
  if (status === "up") return "Ready";
  if (status === "setting-up") return "Setting up";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function AgentsPanel({ client, openWorkspaceTarget, gitIntegration }: AgentsPanelProps) {
  const [accounts, setAccounts] = useState<AgentVmAccount[]>([]);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [agentName, setAgentName] = useState("");
  const [repo, setRepo] = useState("");
  const [repoSource, setRepoSource] = useState<RepoSource>("git-url");
  // "Custom Git URL…" picked in the repo picker while the URL is still empty
  // (a non-empty URL that matches no repo option already reads as custom).
  const [customRepoUrl, setCustomRepoUrl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [nextAccounts, saved, nextSessions] = await Promise.all([
        client.listAccounts(),
        client.getSettings(),
        client.listSessions(),
      ]);
      if (cancelled) return;
      const sortedAccounts = sortAccounts(nextAccounts);
      setAccounts(sortedAccounts);
      setSessions(nextSessions.filter(sessionHasVm));
      setSettings(reconcileSettings(saved, sortedAccounts) ?? defaultSettings(sortedAccounts[0]));
    }
    load().catch((e) => setMessage(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      client
        .listSessions()
        .then((nextSessions) => {
          if (!cancelled) setSessions(nextSessions.filter(sessionHasVm));
        })
        .catch(() => {
          /* keep stale rows visible during background refresh failures */
        });
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [client]);

  useEffect(() => {
    if (!configOpen) return;
    function handleClick(e: MouseEvent) {
      if (configRef.current && !configRef.current.contains(e.target as Node)) {
        setConfigOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [configOpen]);

  useEffect(() => {
    if (!saveNotice) return;
    const id = window.setTimeout(() => setSaveNotice(false), 1800);
    return () => window.clearTimeout(id);
  }, [saveNotice]);

  const selectedAccount = useMemo(
    () =>
      accounts.find(
        (a) =>
          a.accountId === settings?.accountId &&
          a.pluginId === settings.pluginId &&
          a.resourceTypeId === settings.resourceTypeId,
      ) ?? accounts[0],
    [accounts, settings],
  );

  const visibleFields = useMemo(() => {
    if (!selectedAccount) return [];
    return Object.entries(settings?.fields ?? {}).filter(
      ([key]) => !selectedAccount.hiddenFieldKeys.includes(key),
    );
  }, [selectedAccount, settings]);

  const configSummary = useMemo(() => {
    const parts = [
      isT3CodeSurface(settings?.surface)
        ? `T3 Code + ${toolLabel(settings?.tool ?? "codex")}`
        : toolLabel(settings?.tool ?? "codex"),
      ...visibleFields
        .slice(0, 3)
        .map(([key, value]) => formatFieldSummary(fieldLabel(selectedAccount, key), key, value)),
    ].filter(Boolean);
    return parts.join(" · ");
  }, [selectedAccount, settings?.tool, settings?.surface, visibleFields]);

  const gitRepoOptions = useMemo<GitRepoOption[]>(
    () => (gitIntegration?.configured ? gitIntegration.repos : []),
    [gitIntegration],
  );
  const showRepoPicker = repoSource === "git-url" && gitRepoOptions.length > 0;
  const pickedRepo = gitRepoOptions.find((option) => gitRepoCloneUrl(option) === repo);
  const repoPickerValue = pickedRepo ? pickedRepo.fullName : customRepoUrl || repo ? "custom" : "";

  function pickGitRepo(value: string) {
    if (value === "custom") {
      setCustomRepoUrl(true);
      setRepo("");
      return;
    }
    setCustomRepoUrl(false);
    const option = gitRepoOptions.find((candidate) => candidate.fullName === value);
    setRepo(option ? gitRepoCloneUrl(option) : "");
  }

  const accountField = useMemo<CreateFieldConfig>(
    () => ({
      key: "account",
      label: "Account",
      kind: "select",
      required: true,
      options: accounts.map((account) => ({
        id: accountKey(account),
        label: accountLabel(account),
      })),
    }),
    [accounts],
  );

  const toolField = useMemo<CreateFieldConfig>(
    () => ({
      key: "tool",
      label: "Tool",
      kind: "select",
      required: true,
      options: [
        { id: "codex", label: "Codex" },
        { id: "claude-code", label: "Claude Code" },
      ],
    }),
    [],
  );

  // Which agent runs (`tool`) and how you talk to it (`surface`) are separate
  // choices: T3 Code is a control surface that drives the tool's CLI, not an
  // agent of its own, so a T3 Code session still installs Codex or Claude Code.
  const surfaceField = useMemo<CreateFieldConfig>(
    () => ({
      key: "surface",
      label: "Interface",
      kind: "select",
      required: true,
      options: [
        { id: "terminal", label: "Terminal (SSH)" },
        { id: "t3-code", label: "T3 Code" },
      ],
    }),
    [],
  );

  const selectedSurface = agentSurfaceOrDefault(settings?.surface);
  // T3 Code manages its own projects, so these sessions provision a bare
  // server: no repo field, no clone, no branch.
  const needsRepo = agentSurfaceRequiresRepo(selectedSurface);

  async function updateAccount(value: string) {
    const account = accounts.find((a) => accountKey(a) === value);
    if (!account) return;
    const nextSettings = defaultSettings(account, settings?.tool ?? "codex", selectedSurface);
    if (!nextSettings) return;
    setSettings(nextSettings);
    setSaveNotice(false);
    try {
      const saved = await client.saveSettings(nextSettings);
      setSettings(saved);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  function updateField(key: string, value: string) {
    if (!settings) return;
    setSettings({ ...settings, fields: { ...settings.fields, [key]: value } });
  }

  async function saveDefaults() {
    if (!settings) return;
    setBusy(true);
    try {
      const saved = await client.saveSettings(settings);
      setSettings(saved);
      setMessage(null);
      setSaveNotice(true);
      setConfigOpen(false);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    if (!settings || !agentName.trim()) return;
    if (needsRepo && !repo.trim()) return;
    setBusy(true);
    setMessage(null);
    setSaveNotice(false);
    try {
      const created = await client.createSession({
        repo: needsRepo ? repo.trim() : "",
        projectName: agentName.trim(),
        workspaceName: needsRepo ? workspaceNameFromRepo(repo.trim()) : T3_CODE_PROJECTS_DIR,
        settings,
      });
      if (sessionHasVm(created)) {
        setSessions((prev) => [created, ...prev]);
      }
      setAgentName("");
      setRepo("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function browseLocalRepo() {
    if (!client.pickLocalRepoPath) return;
    setSaveNotice(false);
    try {
      const path = await client.pickLocalRepoPath();
      if (path) {
        setRepoSource("local-path");
        setRepo(path);
        setMessage(null);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function openSession(session: AgentSession) {
    if (!session.vmResourceId || openingSessionId) return;
    // Opening re-kicks setup with forceSync when it never completed, so a
    // failed setup can be retried through the same path.
    if (session.status !== "up" && !sessionSetupFailed(session)) return;
    const t3Code = isT3CodeSurface(session.surface);
    setOpeningSessionId(session.id);
    setMessage(
      t3Code
        ? `Opening the setup terminal for ${session.projectName}...`
        : `Opening ${session.projectName}... preparing SSH session.`,
    );
    try {
      // T3 Code servers open the interactive authorization terminal — the
      // rest of the session lives in T3 Code's own app, which the user
      // reaches from their browser once the server is linked.
      await openAgentSshTerminalTab({
        client,
        session,
        title: t3Code
          ? `T3 Code setup · ${session.projectName}`
          : `${toolCommandLabel(session.tool)} · ${session.projectName}`,
        ...(openWorkspaceTarget ? { openWorkspaceTarget } : {}),
      });
      const nextSessions = await client.listSessions().catch(() => null);
      if (nextSessions) setSessions(nextSessions.filter(sessionHasVm));
      setMessage(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningSessionId((current) => (current === session.id ? null : current));
    }
  }

  async function reconcileSession(id: string) {
    try {
      const result = await client.reconcileSession(id);
      setMessage(result.message || `Fetched ${result.branchName}.`);
      const nextSessions = await client.listSessions().catch(() => null);
      if (nextSessions) setSessions(nextSessions.filter(sessionHasVm));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteSession(session: AgentSession) {
    if (deletingSessionId) return;
    const confirmed = window.confirm(
      `Delete agent "${session.projectName}"? This destroys its VM and any work on it that hasn't been reconciled.`,
    );
    if (!confirmed) return;
    setDeletingSessionId(session.id);
    try {
      await client.deleteSession(session.id);
      if (session.vmResourceId) {
        closeSshTabsForAgentTarget(
          resourceSshTabTarget(
            session.accountId,
            session.vmResourceId,
            session.pluginId,
            session.resourceTypeId,
          ),
        );
      }
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
      setMessage(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingSessionId(null);
    }
  }

  return (
    <div className="h-full overflow-auto bg-surface text-on-surface">
      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-base font-semibold">Agents</h1>
            <p className="text-xs text-on-surface-muted">
              Provision coding VMs from cloud accounts and reconcile their branches locally.
            </p>
          </div>
          <div ref={configRef} className="relative w-full lg:w-[420px]">
            <button
              type="button"
              disabled={!selectedAccount || !settings}
              onClick={() => setConfigOpen((v) => !v)}
              className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-border bg-surface-overlay px-3 py-2 text-left hover:bg-surface-sunken disabled:opacity-50"
              aria-expanded={configOpen}
            >
              <ProviderMark account={selectedAccount} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-on-surface">
                  {selectedAccount ? accountLabel(selectedAccount) : "No VM-capable account"}
                </span>
                <span className="block truncate text-xs text-on-surface-muted">
                  {configSummary || "Choose defaults"}
                </span>
              </span>
              <span className="shrink-0 text-xs text-on-surface-faint">
                {configOpen ? "\u25B2" : "\u25BC"}
              </span>
            </button>

            {configOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[min(32rem,calc(100vh-10rem))] w-full flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-raised shadow-xl">
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <div className="space-y-3">
                    <FieldRenderer
                      field={accountField}
                      value={selectedAccount ? accountKey(selectedAccount) : ""}
                      onChange={(value) => void updateAccount(value)}
                    />
                    <FieldRenderer
                      field={toolField}
                      value={settings?.tool ?? "codex"}
                      onChange={(value) =>
                        settings && setSettings({ ...settings, tool: value as AgentTool })
                      }
                    />
                    <FieldRenderer
                      field={surfaceField}
                      value={selectedSurface}
                      onChange={(value) =>
                        settings && setSettings({ ...settings, surface: value as AgentSurface })
                      }
                    />
                    {isT3CodeSurface(selectedSurface) && (
                      <p className="text-xs text-on-surface-muted">
                        T3 Code runs as a server on the VM and drives{" "}
                        {toolLabel(settings?.tool ?? "codex")}, which is installed alongside it.
                        Open runs the one-off authorization steps over SSH; after that you use the
                        server from T3 Code itself. No repository checkout — add projects from
                        inside T3 Code.
                      </p>
                    )}
                    {visibleFields.map(([key, value]) => (
                      <FieldRenderer
                        key={key}
                        field={defaultFieldConfig(selectedAccount, key, value)}
                        value={value}
                        onChange={(nextValue) => updateField(key, nextValue)}
                        formValues={settings?.fields ?? {}}
                      />
                    ))}
                  </div>
                </div>
                <div className="shrink-0 border-t border-border bg-surface-raised p-3">
                  <button
                    type="button"
                    disabled={busy || !settings}
                    onClick={() => void saveDefaults()}
                    className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    Save defaults
                  </button>
                </div>
              </div>
            )}
            {saveNotice && !configOpen && (
              <div className="absolute right-0 top-full z-40 mt-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-200 shadow-lg">
                Agent defaults saved
              </div>
            )}
          </div>
        </div>

        {message && (
          <div className="rounded border border-border bg-surface-overlay px-3 py-2 text-xs text-on-surface-secondary">
            {message}
          </div>
        )}

        <div className="space-y-3">
          <section className="space-y-3">
            <div className="border border-border rounded-lg bg-surface-overlay p-3">
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <input
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder={needsRepo ? "Agent name" : "Server name"}
                    aria-label={needsRepo ? "Agent name" : "Server name"}
                    className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={busy || !settings || !agentName.trim() || (needsRepo && !repo.trim())}
                    onClick={() => void createSession()}
                    className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    Create
                  </button>
                </div>
                {/* A T3 Code server has no Infrawrench-managed checkout, so
                    the repository controls don't apply to it. Left out of the
                    tree rather than hidden with CSS — a hidden-but-focusable
                    URL field is still reachable by keyboard. */}
                {needsRepo && (
                  <div className="flex flex-col gap-2 md:flex-row">
                    <div className="flex shrink-0 rounded-md border border-border-strong bg-surface p-0.5">
                      <button
                        type="button"
                        onClick={() => setRepoSource("git-url")}
                        className={`rounded px-3 py-1.5 text-xs font-medium ${
                          repoSource === "git-url"
                            ? "bg-accent-muted text-accent-on-muted"
                            : "text-on-surface-muted hover:text-on-surface"
                        }`}
                      >
                        Git URL
                      </button>
                      <button
                        type="button"
                        disabled={!client.pickLocalRepoPath}
                        onClick={() => {
                          setRepoSource("local-path");
                          if (!repo && client.pickLocalRepoPath) void browseLocalRepo();
                        }}
                        className={`rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
                          repoSource === "local-path"
                            ? "bg-accent-muted text-accent-on-muted"
                            : "text-on-surface-muted hover:text-on-surface"
                        }`}
                      >
                        Local folder
                      </button>
                    </div>
                    {showRepoPicker && (
                      <select
                        value={repoPickerValue}
                        onChange={(e) => pickGitRepo(e.target.value)}
                        aria-label="Repository"
                        className={`min-w-0 rounded border border-border bg-surface px-2 py-1.5 text-sm ${
                          repoPickerValue === "custom" ? "md:w-56 md:flex-none" : "flex-1"
                        }`}
                      >
                        <option value="">Select a repository…</option>
                        {gitRepoOptions.map((option) => (
                          <option
                            key={`${option.installationId}:${option.fullName}`}
                            value={option.fullName}
                          >
                            {option.fullName}
                            {option.private ? " (private)" : ""}
                          </option>
                        ))}
                        <option value="custom">Custom Git URL…</option>
                      </select>
                    )}
                    {(!showRepoPicker || repoPickerValue === "custom") && (
                      <input
                        value={repo}
                        onChange={(e) => setRepo(e.target.value)}
                        placeholder={
                          repoSource === "git-url"
                            ? "https://github.com/org/repo.git"
                            : client.pickLocalRepoPath
                              ? "/path/to/local/repo"
                              : "Local folders are available in the desktop app"
                        }
                        aria-label={
                          repoSource === "git-url" ? "Repository Git URL" : "Local repository path"
                        }
                        className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
                      />
                    )}
                    {repoSource === "git-url" &&
                      gitIntegration?.configured &&
                      gitRepoOptions.length === 0 && (
                        <button
                          type="button"
                          onClick={gitIntegration.onConnect}
                          className="rounded border border-border-strong px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-sunken"
                        >
                          {gitIntegration.loading ? "Loading repos…" : "Connect GitHub"}
                        </button>
                      )}
                    {showRepoPicker && (
                      <button
                        type="button"
                        onClick={gitIntegration?.onConnect}
                        title="Add or remove repositories on GitHub"
                        className="shrink-0 rounded border border-border-strong px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-sunken"
                      >
                        + repos
                      </button>
                    )}
                    {repoSource === "local-path" && client.pickLocalRepoPath && (
                      <button
                        type="button"
                        onClick={() => void browseLocalRepo()}
                        className="rounded border border-border-strong px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-sunken"
                      >
                        Browse
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
              {sessions.length === 0 ? (
                <div className="p-4 text-xs text-on-surface-muted">No agent VMs yet.</div>
              ) : (
                sessions.map((session) => {
                  const sessionAccount = accounts.find(
                    (account) =>
                      account.accountId === session.accountId &&
                      account.pluginId === session.pluginId &&
                      account.resourceTypeId === session.resourceTypeId,
                  );
                  return (
                    <div
                      key={session.id}
                      className="p-3 border-b border-border last:border-b-0 bg-surface-overlay"
                    >
                      <div className="flex items-start justify-between gap-3">
                        {/* select-text: the desktop app root disables selection globally */}
                        <div className="min-w-0 select-text">
                          <div className="flex items-center gap-2">
                            <span
                              className={`size-2 rounded-full ${statusClass(session.status)}`}
                            />
                            <span className="font-medium text-sm truncate">
                              {session.projectName}
                            </span>
                            <span className="text-xs text-on-surface-muted">
                              {statusLabel(session.status)}
                            </span>
                          </div>
                          {isT3CodeSurface(session.surface) ? (
                            <div className="mt-1 text-xs text-on-surface-muted">
                              T3 Code server driving {toolLabel(session.tool)} · projects managed in
                              T3 Code
                            </div>
                          ) : (
                            <>
                              <div className="mt-1 text-xs text-on-surface-muted truncate">
                                {session.repo}
                              </div>
                              <div className="mt-1 text-xs font-mono text-on-surface-tertiary">
                                {session.branchName}
                              </div>
                            </>
                          )}
                          <div className="mt-1 text-xs text-on-surface-tertiary truncate">
                            {sessionLocationLabel(session, sessionAccount)}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {session.status === "up" && (
                            <button
                              type="button"
                              disabled={!!openingSessionId || !session.vmResourceId}
                              onClick={() => void openSession(session)}
                              aria-busy={openingSessionId === session.id}
                              title={
                                isT3CodeSurface(session.surface)
                                  ? "Run the T3 Connect and provider sign-in steps over SSH"
                                  : undefined
                              }
                              className="px-2 py-1 rounded border border-border text-xs disabled:opacity-50"
                            >
                              {openingSessionId === session.id
                                ? "Opening..."
                                : isT3CodeSurface(session.surface)
                                  ? "Authorize server"
                                  : "Open"}
                            </button>
                          )}
                          {sessionSetupFailed(session) && (
                            <button
                              type="button"
                              disabled={!!openingSessionId || !session.vmResourceId}
                              onClick={() => void openSession(session)}
                              aria-busy={openingSessionId === session.id}
                              className="px-2 py-1 rounded border border-border text-xs disabled:opacity-50"
                            >
                              {openingSessionId === session.id ? "Retrying..." : "Retry setup"}
                            </button>
                          )}
                          {/* Reconcile pushes the session branch back; a T3
                              Code server has no Infrawrench-managed checkout
                              to reconcile. */}
                          {!sessionIsSettingUp(session) && !isT3CodeSurface(session.surface) && (
                            <button
                              type="button"
                              onClick={() => void reconcileSession(session.id)}
                              className="px-2 py-1 rounded border border-border text-xs"
                            >
                              Reconcile
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={!!deletingSessionId}
                            onClick={() => void deleteSession(session)}
                            aria-busy={deletingSessionId === session.id}
                            className="px-2 py-1 rounded border border-red-500/40 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                          >
                            {deletingSessionId === session.id ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </div>
                      {session.logs.length > 0 && (
                        <pre className="mt-2 max-h-24 select-text overflow-auto rounded bg-surface px-2 py-1 text-[11px] text-on-surface-muted">
                          {session.logs.join("\n")}
                        </pre>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function gitRepoCloneUrl(option: GitRepoOption): string {
  return `https://github.com/${option.fullName}.git`;
}

function accountKey(account: AgentVmAccount): string {
  return `${account.accountId}:${account.pluginId}:${account.resourceTypeId}`;
}

function sortAccounts(accounts: AgentVmAccount[]): AgentVmAccount[] {
  return [...accounts].sort((a, b) =>
    accountLabel(a).localeCompare(accountLabel(b), undefined, { sensitivity: "base" }),
  );
}

function accountLabel(account: AgentVmAccount): string {
  return `${account.accountName} (${account.pluginName})`;
}

function sessionHasVm(session: AgentSession): boolean {
  return Boolean(session.vmResourceId);
}

function sessionIsSettingUp(session: AgentSession): boolean {
  return (
    session.status === "pending" ||
    session.status === "provisioning" ||
    session.status === "setting-up"
  );
}

function sessionSetupFailed(session: AgentSession): boolean {
  if (session.status !== "setting-up") return false;
  const lastLog = session.logs[session.logs.length - 1];
  return Boolean(lastLog?.startsWith(AGENT_SETUP_FAILED_LOG_PREFIX));
}

function sessionLocationLabel(session: AgentSession, account: AgentVmAccount | undefined): string {
  return `${account ? accountLabel(account) : session.pluginId} · VM ${session.vmResourceId}`;
}

function ProviderMark({ account }: { account: AgentVmAccount | undefined }) {
  if (account?.pluginLogoSvg) {
    return (
      <span
        className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-strong bg-surface p-1.5"
        aria-hidden="true"
        // pluginLogoSvg is bundled provider metadata from trusted plugin manifests.
        dangerouslySetInnerHTML={{ __html: account.pluginLogoSvg }}
      />
    );
  }

  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border-strong bg-surface text-xs font-semibold uppercase text-on-surface-secondary">
      {providerMark(account?.pluginName)}
    </span>
  );
}

function providerMark(pluginName: string | undefined): string {
  if (!pluginName) return "--";
  return pluginName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

function toolLabel(tool: AgentTool): string {
  return tool === "claude-code" ? "Claude Code" : "Codex";
}

function fieldLabel(account: AgentVmAccount | undefined, key: string): string {
  return (
    account?.defaultFieldLabels?.[key] ??
    account?.createFields?.find((field) => field.key === key)?.label ??
    humanizeFieldKey(key)
  );
}

function defaultFieldConfig(
  account: AgentVmAccount | undefined,
  key: string,
  value: string,
): CreateFieldConfig {
  const createField = account?.createFields?.find((field) => field.key === key);
  if (createField) {
    const { showWhen: _showWhen, ...field } = createField;
    return {
      ...field,
      label: account?.defaultFieldLabels?.[key] ?? createField.label,
      required: false,
    };
  }
  const label = account?.defaultFieldLabels?.[key] ?? humanizeFieldKey(key);
  if (/disk.*gb/i.test(key)) {
    return {
      key,
      label,
      kind: "disk-slider",
      required: false,
      minGb: 10,
      maxGb: 2000,
      stepGb: 10,
      defaultGb: Number(value) || 40,
    };
  }
  if (/gb$/i.test(key) || /^\d+$/.test(value)) {
    return {
      key,
      label,
      kind: "number",
      required: false,
      minValue: 0,
      stepValue: 1,
    };
  }
  return {
    key,
    label,
    kind: "text",
    required: false,
    placeholder: label,
  };
}

function humanizeFieldKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\bgb\b/gi, "GB")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatFieldSummary(label: string, key: string, value: string): string {
  if (!value) return label;
  const displayValue = /disk.*gb/i.test(key) ? `${value}GB` : value;
  return `${label}: ${displayValue}`;
}

/**
 * Bring saved settings up to date with the matching account's current
 * defaults: providers gain new default fields over time (e.g. DigitalOcean's
 * region), and a settings row saved before that addition would otherwise
 * never show the new field. Keys the account no longer declares are dropped.
 * Returns null when the saved account doesn't exist anymore.
 */
function reconcileSettings(
  saved: AgentSettings | null,
  accounts: AgentVmAccount[],
): AgentSettings | null {
  if (!saved) return null;
  const account = accounts.find(
    (a) =>
      a.accountId === saved.accountId &&
      a.pluginId === saved.pluginId &&
      a.resourceTypeId === saved.resourceTypeId,
  );
  if (!account) return null;
  const fields: Record<string, string> = {};
  for (const [key, defaultValue] of Object.entries(account.defaultFields)) {
    fields[key] = saved.fields[key] ?? defaultValue;
  }
  return { ...saved, fields };
}

function defaultSettings(
  account: AgentVmAccount | undefined,
  tool: AgentTool = "codex",
  surface: AgentSurface = "terminal",
) {
  if (!account) return null;
  return {
    accountId: account.accountId,
    pluginId: account.pluginId,
    resourceTypeId: account.resourceTypeId,
    tool,
    surface,
    fields: { ...account.defaultFields },
  };
}

function toolCommandLabel(tool: AgentTool): string {
  return tool === "claude-code" ? "claude" : "codex";
}

function workspaceNameFromRepo(repo: string): string {
  const trimmed = repo.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) return "project";
  const last = trimmed.split(/[\\/]/).pop() ?? "project";
  return last.replace(/\.git$/i, "") || "project";
}
