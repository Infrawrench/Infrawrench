/**
 * Where the forge's review agents run, on what model, and how much one run
 * may use.
 *
 * **Who pays.** A run is the organisation's that owns the repository the
 * pull request is in, and it draws on the organisation's one AI spend pool,
 * the same one AI chat and `infra.ai()` use (server-core's
 * `billing/ai-usage.ts`): a monthly cap an administrator sets under Settings
 * > AI Chat, and the free allowance for an organisation without a paid plan.
 * A run is admitted against the pool before it starts and what it used is
 * written to it when it ends. A person's own namespace has no organisation
 * and so no pool: its review agents run in the organisation its owner
 * connected it to (`runsInOrganization`), on that organisation's pool exactly
 * as one of its own repositories would, and do not run until it is connected.
 */
import type { ReviewerKind } from "@infrawrench/git-contract";
import { isAnthropicConfigured } from "@infrawrench/server-core/anthropic-client";
import { type RepositoryWithOwner, runsInOrganization } from "../db/repositories";

/** The model each of the forge's reviewers runs on. */
export const REVIEWER_MODELS: Readonly<Record<ReviewerKind, string>> = {
  general: "claude-opus-5-5",
  security: "claude-opus-5-5",
  tests: "claude-opus-5-5",
  terraform: "claude-opus-5-5",
  intent: "claude-opus-5-5",
};

/** How hard each reviewer thinks (`output_config.effort`). */
export const REVIEWER_EFFORT: Readonly<Record<ReviewerKind, "medium" | "high">> = {
  general: "high",
  security: "high",
  tests: "medium",
  terraform: "medium",
  intent: "medium",
};

export interface ReviewLimits {
  /** A run still `running` this long after it started is taken to be dead. Past the consumer's 15 minutes. */
  readonly leaseMs: number;
  /** A run stops asking the model this long after it started. Inside the consumer's 15 minutes. */
  readonly deadlineMs: number;
  /** One model call. */
  readonly turnTimeoutMs: number;
  /** Model calls one reviewer makes. */
  readonly maxTurns: number;
  readonly maxOutputTokensPerTurn: number;
  /** What one reviewer may cost, in millionths of a dollar as billed. */
  readonly reviewerBudgetMicros: number;
  /** What is held from the organisation's pool per reviewer while a run is in flight. */
  readonly reserveMicrosPerReviewer: number;
  /** Findings one reviewer may raise on one version. */
  readonly maxFindingsPerReviewer: number;
  /** Characters of one tool result. More is cut, and the model is told. */
  readonly toolResultChars: number;
  /** Deliveries of one run before it is failed instead of tried again. */
  readonly maxAttempts: number;
}

export const REVIEW_LIMITS: ReviewLimits = {
  leaseMs: 16 * 60_000,
  deadlineMs: 10 * 60_000,
  turnTimeoutMs: 3 * 60_000,
  maxTurns: 24,
  maxOutputTokensPerTurn: 16_000,
  reviewerBudgetMicros: 2_000_000,
  reserveMicrosPerReviewer: 400_000,
  maxFindingsPerReviewer: 30,
  toolResultChars: 24_000,
  maxAttempts: 3,
};

export type ReviewAvailability =
  | { readonly available: true; readonly organizationId: string }
  | { readonly available: false; readonly reason: string };

export const REVIEW_NEEDS_ORGANISATION =
  "Review agents run in an organisation. Choose one for your own repositories in Settings > Profile";
export const REVIEW_NOT_CONFIGURED = "Review agents are not set up on this server";

/** Whether the forge's review agents can run for a repository at all, and who pays when they do. */
export const reviewAvailability = (
  repo: RepositoryWithOwner,
  configured: boolean = isAnthropicConfigured(),
): ReviewAvailability => {
  const organizationId = runsInOrganization(repo.owner);
  if (organizationId === null) return { available: false, reason: REVIEW_NEEDS_ORGANISATION };
  if (!configured) return { available: false, reason: REVIEW_NOT_CONFIGURED };
  return { available: true, organizationId };
};
