/**
 * The mock's T3 Code state: the signed-in person's environments and the
 * threads each one would list. Only the `t3` handlers write it. Three are on
 * T3 Connect addresses (`prod-<16 hex>.<zone>`, the shape the contract's
 * `t3-connect.ts` checks) and one on a typed address.
 *
 * Studio's project for `acme/infra` has a default model. The Mac mini's
 * projects have none, so starting work there waits for a model, and its
 * first launch is refused once (`t3LaunchRefusals`), which is how the branch
 * page's failed state and its Try again are reached.
 */
import type {
  AgentLink,
  T3Environment,
  T3ModelChoice,
  T3ModelProvider,
  T3Thread,
} from "@infrawrench/git-contract";
import type { Mutable } from "./define";

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
const daysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString();

/** How long a sign-in lasts, as T3 Code has it. */
export const T3_SIGN_IN_DAYS = 30;

export const t3Environments: Mutable<T3Environment>[] = [
  {
    id: "t3env_studio",
    label: "Studio",
    baseUrl: "https://prod-4f1c09ab72de3a65.t3coderelay.com",
    status: "connected",
    scopes: ["orchestration:read", "orchestration:operate"],
    tokenExpiresAt: daysFromNow(22),
    lastError: null,
    lastUsedAt: hoursAgo(3),
    createdAt: hoursAgo(8 * 24),
    updatedAt: hoursAgo(3),
  },
  {
    id: "t3env_mini",
    label: "Mac mini",
    baseUrl: "https://prod-07d3e1b4a95c26f8.t3coderelay.com",
    status: "connected",
    scopes: ["orchestration:read", "orchestration:operate"],
    tokenExpiresAt: daysFromNow(29),
    lastError: null,
    lastUsedAt: hoursAgo(20),
    createdAt: hoursAgo(26),
    updatedAt: hoursAgo(20),
  },
  {
    id: "t3env_laptop",
    label: "Laptop",
    baseUrl: "https://prod-b8e2d4017c96f3a0.t3coderelay.com",
    status: "error",
    scopes: ["orchestration:read"],
    tokenExpiresAt: null,
    lastError: "The environment did not accept this site's sign-in. Sign in to it again.",
    lastUsedAt: hoursAgo(31 * 24),
    createdAt: hoursAgo(40 * 24),
    updatedAt: hoursAgo(26),
  },
  {
    id: "t3env_build",
    label: "Build box",
    baseUrl: "https://build.acme.example",
    status: "pending",
    scopes: [],
    tokenExpiresAt: null,
    lastError: null,
    lastUsedAt: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  },
];

export const t3Threads: Record<string, T3Thread[]> = {
  t3env_studio: [
    {
      id: "t3thread_peering",
      title: "Peer the staging and shared VPCs",
      projectId: "t3project_infra",
      projectName: "acme/infra",
      updatedAt: hoursAgo(2),
    },
    {
      id: "t3thread_backups",
      title: "Nightly database backups",
      projectId: "t3project_infra",
      projectName: "acme/infra",
      updatedAt: hoursAgo(30),
    },
    {
      id: "t3thread_router",
      title: "Retry budget for the edge router",
      projectId: "t3project_router",
      projectName: "acme/edge-router",
      updatedAt: hoursAgo(5 * 24),
    },
  ],
};

/** What every connected environment of the mock can run. */
export const t3Providers: T3ModelProvider[] = [
  {
    id: "codex",
    name: "Codex",
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        reasoning: {
          optionId: "reasoningEffort",
          levels: ["low", "medium", "high"],
          default: "medium",
        },
      },
    ],
  },
  {
    id: "claudeAgent",
    name: "Claude",
    models: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        reasoning: {
          optionId: "effort",
          levels: ["low", "medium", "high", "xhigh"],
          default: "high",
        },
      },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", reasoning: null },
    ],
  },
];

/** The default model of an environment's project for a repository (`owner/repo`). */
export const t3ProjectDefaults: Record<string, Record<string, T3ModelChoice>> = {
  t3env_studio: {
    "acme/infra": {
      providerId: "claudeAgent",
      model: "claude-opus-5-5",
      reasoning: { optionId: "effort", level: "high" },
    },
  },
};

/** A launch in an environment is refused with this, once. */
export const t3LaunchRefusals: Record<string, string> = {
  t3env_mini: "The branch is already checked out in another worktree. No thread was created.",
};

let launched = 0;

/**
 * What the forge leaves on a branch's agent after asking an environment to
 * start a thread: the thread and the model it got, or why there is none.
 */
export const launchT3Thread = (
  environmentId: string,
  repository: string,
  chosen: T3ModelChoice | undefined,
): AgentLink["externalRefs"] => {
  const refusal = t3LaunchRefusals[environmentId];
  if (refusal !== undefined) {
    delete t3LaunchRefusals[environmentId];
    return { projectId: "t3project_new", launchError: refusal };
  }
  const preset = t3ProjectDefaults[environmentId]?.[repository];
  // Nobody chose and the project has no default: the forge picks, Claude first.
  const picked = t3Providers.find((each) => each.id === "claudeAgent")!;
  const choice = chosen ??
    preset ?? {
      providerId: picked.id,
      model: picked.models[0]!.id,
      reasoning: { optionId: "effort", level: "high" },
    };
  const provider = t3Providers.find((each) => each.id === choice.providerId);
  const model = provider?.models.find((each) => each.id === choice.model);
  const label = model?.label ?? choice.model;
  const name = provider?.name ?? choice.providerId;
  const threadId = `t3thread_new${++launched}`;
  return {
    threadId,
    projectId: "t3project_new",
    threadUrl: `https://app.t3.codes/threads/${environmentId}/${threadId}`,
    modelProviderId: choice.providerId,
    modelId: choice.model,
    modelName: label.toLowerCase().startsWith(name.toLowerCase()) ? label : `${name}, ${label}`,
    ...(choice.reasoning === undefined ? {} : { reasoningLevel: choice.reasoning.level }),
    ...(chosen === undefined && preset === undefined ? { modelPickedBy: "forge" } : {}),
  };
};

let made = 0;
export const newT3Id = (): string => `t3env_${Date.now().toString(36)}${++made}`;

export const signInT3 = (environment: Mutable<T3Environment>): void => {
  const now = new Date().toISOString();
  environment.status = "connected";
  environment.scopes = ["orchestration:read", "orchestration:operate"];
  environment.tokenExpiresAt = daysFromNow(T3_SIGN_IN_DAYS);
  environment.lastError = null;
  environment.updatedAt = now;
};
