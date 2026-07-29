/** Shared UI-side shapes for deployments. Kept decoupled from server types. */
import type { WorkflowRunLog } from "../workflows/types.js";

export type DeployStage = "plan" | "dockerfile" | "build" | "deploy" | "destroy";

export type DeployStatus = "pending" | "running" | "success" | "failure" | "canceled";

/**
 * Order the stage indicator walks through. `destroy` is deliberately absent:
 * a teardown run has no build pipeline to render progress against, so the
 * indicator shows nothing for it (indexOf returns -1).
 */
export const DEPLOY_STAGES: readonly DeployStage[] = ["plan", "dockerfile", "build", "deploy"];

export interface DeployRepo {
  fullName: string;
  defaultBranch: string;
}

/** What a repo's Infrafile declares, read at a branch head. */
export interface DeployEnvs {
  envs: string[];
  sha: string;
  repo: string;
  branch: string;
}

export interface DeployRunResult {
  status: DeployStatus;
  env: string;
  plan?: unknown;
  /** The *rendered* Dockerfile. The Infrafile source is never returned. */
  dockerfile?: string;
  image?: string;
  notes: string[];
  logs: WorkflowRunLog[];
  reachedStage?: DeployStage;
  error?: { message: string; stack?: string };
  durationMs: number;
}

export interface DeploymentRunRow {
  id: string;
  env: string;
  repo: string | null;
  branch: string | null;
  gitSha: string | null;
  image: string | null;
  status: DeployStatus;
  origin: "web" | "cli" | "trigger";
  stage: DeployStage | null;
  durationMs: number | null;
  startedAt: string;
}

/**
 * A watched branch: when `repo`@`branch` moves, deploy `env`.
 *
 * `lastSha` is the commit the watcher last saw, not the commit it last shipped:
 * the first look records HEAD without deploying, so a freshly created trigger
 * has a SHA and no run.
 */
export interface DeployTrigger {
  id: string;
  repo: string;
  branch: string;
  env: string;
  enabled: boolean;
  lastSha: string | null;
  lastRunAt: string | null;
}

export interface DeployTriggerInput {
  repo: string;
  branch: string;
  env: string;
  /**
   * Answers for the Infrafile's `select(...)` keys. A triggered run has nobody
   * to ask, so a key with no answer here fails the deploy rather than prompting.
   */
  answers?: Record<string, string>;
}

/** Live callbacks for a deploy driven over the websocket. */
export interface DeploySession {
  onLog?: (entry: WorkflowRunLog) => void;
  onStage?: (stage: DeployStage) => void;
  /** Ask the server to stop; set by the transport once the socket is open. */
  stop?: () => void;
}

export interface DeployStartOptions {
  repo: string;
  branch: string;
  env?: string;
  planOnly?: boolean;
}

/**
 * Transport contract. Only the web implements it today — the CLI runs the same
 * stages locally rather than through an API — but keeping the panel behind an
 * interface is what let workflows grow a second (desktop) client later.
 */
export interface DeploymentClient {
  listRepos(): Promise<DeployRepo[]>;
  listEnvs(repo: string, branch: string): Promise<DeployEnvs>;
  /** Plan-only preview over HTTP; no prompts, so any select() needs an answer. */
  plan(opts: DeployStartOptions): Promise<{ runId: string; result: DeployRunResult }>;
  /** Full interactive deploy over the websocket. */
  deploy(
    opts: DeployStartOptions,
    session: DeploySession,
  ): Promise<{ runId: string; result: DeployRunResult }>;
  listRuns(env?: string): Promise<DeploymentRunRow[]>;
  /**
   * Ship a past run's artifact again. Builds nothing — see the Infrafile docs
   * for why a rollback replays rather than reconstructs.
   */
  rollback(runId: string): Promise<{ runId: string; result: DeployRunResult }>;
  listTriggers(): Promise<DeployTrigger[]>;
  createTrigger(input: DeployTriggerInput): Promise<DeployTrigger>;
  /** Only `enabled` is editable — the rest is identity, so recreate instead. */
  updateTrigger(id: string, input: { enabled: boolean }): Promise<DeployTrigger>;
  deleteTrigger(id: string): Promise<void>;
}
