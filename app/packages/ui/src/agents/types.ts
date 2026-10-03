import type { CreateFieldConfig, SshInstallAccount } from "@infrawrench/plugin-base";

/** The coding agent CLI installed on the session's VM. */
export type AgentTool = "codex" | "claude-code";

/**
 * What the session's main tab shows — orthogonal to which agent runs.
 *
 * - `terminal`: the tool's CLI, attached in an SSH terminal (the original
 *   behaviour, and still the default).
 * - `t3-code`: T3 Code (https://github.com/pingdotgg/t3code) runs as a server
 *   on the VM and *drives* the tool's CLI, so the main tab is its embedded
 *   app. T3 Code is a control surface, not an agent: it ships no model access
 *   of its own and still needs `codex` or `claude` installed and signed in
 *   next to it — which is why `tool` still applies. See `t3-code.ts`.
 */
export type AgentSurface = "terminal" | "t3-code";

/**
 * How a T3 Code server is reached. `t3-connect` (the default) links it to
 * T3's hosted relay; `tailscale` publishes it on the tailnet with Tailscale
 * Serve instead, and needs an attached Tailscale service account.
 */
export type T3CodeAccess = "t3-connect" | "tailscale";

/**
 * A service a plugin installed on the session's VM over SSH (e.g. Tailscale
 * enrollment). Plugin-owned `ref` is kept server-side for cleanup.
 */
export interface AgentServiceInstall {
  accountId: string;
  pluginId: string;
  message: string;
  address?: string;
}
export type AgentStatus = "pending" | "provisioning" | "setting-up" | "up" | "failed" | "stopped";
export type AgentRuntimeLanguage = "node" | "php" | "ruby" | "go";
export type AgentRuntimeVersionSource = "project" | "latest";

export interface AgentRuntimePlan {
  language: AgentRuntimeLanguage;
  version: string;
  versionSource: AgentRuntimeVersionSource;
  source: string;
  reasons: string[];
}

/**
 * A resource the repo asks Infrawrench to create per agent session (e.g. a
 * database branch). Declared in `.infrawrench/agent.json`; matched to one of
 * the user's accounts by plugin id (and optional account display name).
 */
export interface AgentRepoResourceSpec {
  /** Plugin that creates the resource, e.g. "neon". */
  pluginId: string;
  resourceTypeId: string;
  /** Disambiguates when several accounts exist for the plugin (display name). */
  account?: string;
  /** Base name for the created resource; the session id is appended. */
  name?: string;
  /** Create-form fields passed through to the plugin. */
  fields?: Record<string, string>;
  /**
   * Env vars derived from the created resource. Values may reference
   * `{{outputs.<key>}}` and `{{fields.<key>}}` of the created resource.
   */
  env?: Record<string, string>;
}

/** Parsed `.infrawrench/agent.json` from the session's repository. */
export interface AgentRepoConfig {
  /** Static env vars for the agent VM. */
  env?: Record<string, string>;
  /** Resources created per session, with env mapped from their outputs. */
  resources?: AgentRepoResourceSpec[];
}

export interface AgentSetupPlan {
  source: "git-url" | "local-folder";
  workspaceName: string;
  initialCloneUrl?: string | undefined;
  runtimes: AgentRuntimePlan[];
  packageManagers: string[];
  configSources: Array<{
    label: string;
    localPath: string;
    exists: boolean;
  }>;
  warnings: string[];
  /** Repo-provided agent config (local-folder sessions only). */
  repoConfig?: AgentRepoConfig;
}

export interface AgentVmAccount {
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  pluginLogoSvg?: string;
  resourceTypeId: string;
  resourceTypeName: string;
  defaultUsername: string;
  defaultFields: Record<string, string>;
  defaultFieldLabels?: Record<string, string>;
  createFields?: CreateFieldConfig[];
  hiddenFieldKeys: string[];
}

export interface AgentSettings {
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  tool: AgentTool;
  /** Absent on rows saved before T3 Code sessions existed; treat as "terminal". */
  surface?: AgentSurface;
  fields: Record<string, string>;
  /**
   * Accounts whose plugin installs a service on the VM over SSH once it is
   * set up (any plugin declaring `sshInstall`, e.g. Tailscale).
   */
  serviceAccountIds?: string[];
  /** T3 Code sessions only; absent means T3 Connect. */
  t3Access?: T3CodeAccess;
}

export interface AgentSession {
  id: string;
  repo: string;
  projectName: string;
  workspaceName: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  tool: AgentTool;
  /** Absent on sessions created before T3 Code sessions existed. */
  surface?: AgentSurface;
  serviceAccountIds?: string[];
  t3Access?: T3CodeAccess;
  /** Services installed on the VM so far, in attach order. */
  serviceInstalls?: AgentServiceInstall[];
  branchName: string;
  status: AgentStatus;
  vmResourceId?: string | null;
  logs: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * SSH endpoint of an agent-session VM as resolved by the setup pipeline.
 * Shared wire shape between the web server pipeline (`web/services/agent-setup.ts`)
 * and its desktop mirror (`desktop/src/lib/agent-client.ts`).
 */
export interface AgentSshTarget {
  host: string;
  port: number;
  username: string;
}

/**
 * Resolved SSH launch metadata (managed key + launch command/cwd) for an agent
 * session's terminal tab. Both hosts rehydrate this when a deep link or
 * restored tab only carries `agentSession` — see `web/src/lib/agent-launch.ts`
 * and desktop's ResourcePanel agent-launch resolution.
 */
export interface AgentLaunchDefaults {
  sshKeyId?: string;
  sshKeyName?: string;
  initialCommand?: string;
  initialCwd?: string;
}

/**
 * The single "nothing rehydrated" value for {@link AgentLaunchDefaults}.
 *
 * Both hosts clear these defaults from an effect whose dependency list contains
 * `gt` (per the project's i18n rule), and `useGT()` does not return a
 * referentially stable function — so that effect re-runs on *every* render.
 * Writing a fresh `{}` there is therefore a self-sustaining render loop:
 * new object → state change → render → new `gt` → effect → new object → …
 *
 * A shared frozen constant makes the clear idempotent, because React bails out
 * of a `setState` whose next value is `Object.is`-equal to the current one.
 * The loop it prevents is not cosmetic: a permanently re-rendering page never
 * goes idle, and Monaco tokenises on `requestIdleCallback`, so every editor on
 * the page renders unhighlighted (see issue #123).
 *
 * Always use this for the initial state and for every "no defaults" write.
 * Never write an inline `{}`.
 */
export const NO_AGENT_LAUNCH_DEFAULTS: AgentLaunchDefaults = Object.freeze({});

export interface AgentCreateBody {
  repo: string;
  projectName?: string;
  workspaceName?: string;
  settings: AgentSettings;
}

export interface AgentClient {
  listAccounts(): Promise<AgentVmAccount[]>;
  /** Accounts that can install a service on the VM over SSH (e.g. Tailscale). */
  listServiceAccounts?(): Promise<SshInstallAccount[]>;
  getSettings(): Promise<AgentSettings | null>;
  saveSettings(settings: AgentSettings): Promise<AgentSettings>;
  pickLocalRepoPath?(): Promise<string | null>;
  listSessions(): Promise<AgentSession[]>;
  createSession(body: AgentCreateBody): Promise<AgentSession>;
  openSession(id: string): Promise<{
    command: string;
    cwd: string;
    sshKeyId?: string;
    sshKeyName?: string;
  }>;
  reconcileSession(id: string): Promise<{ branchName: string; message: string }>;
  /** Delete the session and destroy its VM (if it still exists). */
  deleteSession(id: string): Promise<void>;
}

/**
 * Full `openSession` response per the contract above — the server also returns
 * the managed key (`sshKeyId`/`sshKeyName`) alongside `command`/`cwd`. Derived
 * here, once, so the web and desktop clients cannot drift from the interface.
 */
export type AgentOpenSessionResult = Awaited<ReturnType<AgentClient["openSession"]>>;
