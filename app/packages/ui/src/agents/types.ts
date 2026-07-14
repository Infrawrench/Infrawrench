import type { CreateFieldConfig } from "@infrawrench/plugin-base";

export type AgentTool = "codex" | "claude-code";
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

export interface AgentSetupPlan {
  source: "git-url" | "local-folder";
  workspaceName: string;
  initialCloneUrl?: string;
  runtimes: AgentRuntimePlan[];
  packageManagers: string[];
  configSources: Array<{
    label: string;
    localPath: string;
    exists: boolean;
  }>;
  warnings: string[];
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
  fields: Record<string, string>;
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

export interface AgentCreateBody {
  repo: string;
  projectName?: string;
  workspaceName?: string;
  settings: AgentSettings;
}

export interface AgentClient {
  listAccounts(): Promise<AgentVmAccount[]>;
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
}
