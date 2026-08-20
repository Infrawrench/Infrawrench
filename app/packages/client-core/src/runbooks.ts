/**
 * Runbooks — the checklist somebody wrote down at 03:00, made runnable.
 *
 * An organization's recovery knowledge normally lives in three places: a wiki
 * page nobody updated, a Slack thread from the last incident, and one
 * engineer's memory. What this adds is a place for it *inside the tool the
 * steps are performed in* — so a step that says "run the failover workflow" is
 * a button, and a run leaves a record of who did what and when.
 *
 * This module is the pure half: the shapes all three surfaces agree on, the
 * validation both the editor and the API enforce, the progress arithmetic, and
 * the rule that decides which runbooks apply to a given resource.
 */

/**
 * What a step does.
 *
 * Deliberately three kinds and not a scripting language. A runbook is written
 * by whoever is on call *for* whoever is on call next, and the moment it needs
 * a language it stops being written. `workflow` is the escape hatch: anything
 * genuinely automated belongs in a workflow, which already has a sandbox, an
 * approval flow, secrets and a run history.
 */
export type RunbookStepKind = "manual" | "workflow" | "link";

export interface RunbookStep {
  /**
   * Stable across edits, because a run's per-step records reference it. A step
   * reordered or retitled is the same step; only deleting one orphans its
   * history, which is why runs keep the title they saw.
   */
  id: string;
  kind: RunbookStepKind;
  title: string;
  /** Markdown. The detail nobody remembers at 03:00. */
  body: string;
  /** For `workflow` steps: which workflow the button runs. */
  workflowId?: string | undefined;
  /** For `link` steps: where the button goes. `https:` only. */
  url?: string | undefined;
}

export interface Runbook {
  id: string;
  name: string;
  description: string | null;
  steps: RunbookStep[];
  /**
   * Resource types this runbook is *about*; empty means it is not scoped to a
   * type. Used to answer "which runbooks apply here", never to restrict who
   * may open it — a runbook nobody can find is the failure mode this feature
   * exists to fix.
   */
  resourceTypeIds: string[];
  /** Optional tag narrowing, the backup-policy selector shape. */
  tagKey: string | null;
  tagValue: string | null;
  /** Off keeps the row and hides it from the "what applies here" lookup. */
  enabled: boolean;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Runs started from this runbook, for the list's "used 4 times" line. */
  runCount: number;
  lastRunAt: string | null;
}

export interface RunbookInput {
  name: string;
  description?: string | null;
  steps?: RunbookStepInput[];
  resourceTypeIds?: string[];
  tagKey?: string | null;
  tagValue?: string | null;
  enabled?: boolean;
}

export interface RunbookStepInput {
  /** Omitted for a new step; the server assigns one. */
  id?: string | undefined;
  kind: RunbookStepKind;
  title: string;
  body?: string | undefined;
  workflowId?: string | null | undefined;
  url?: string | null | undefined;
}

export type RunbookRunStatus = "running" | "completed" | "abandoned";
export type RunbookStepStatus = "pending" | "done" | "skipped" | "failed";

export interface RunbookRunStep {
  /** The step's id at the time the run started. */
  stepId: string;
  /**
   * The step's title as it was when the run started.
   *
   * Copied rather than joined, because the runbook is edited between incidents
   * and a postmortem that shows today's wording against last month's run is
   * worse than useless — it is quietly wrong.
   */
  title: string;
  kind: RunbookStepKind;
  status: RunbookStepStatus;
  /** What the responder typed — the output, the reason it was skipped. */
  note: string | null;
  /** Workflow run this step kicked off, when it was a `workflow` step. */
  workflowRunId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  updatedAt: string | null;
}

export interface RunbookRun {
  id: string;
  runbookId: string;
  runbookName: string;
  status: RunbookRunStatus;
  /** Incident this run was performed under, when it was started from one. */
  incidentId: string | null;
  startedByUserId: string | null;
  startedByName: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Free-text wrap-up, written when the run is closed. */
  summary: string | null;
  steps: RunbookRunStep[];
}

export const RUNBOOK_LIMITS = {
  nameMaxLength: 120,
  descriptionMaxLength: 2000,
  maxSteps: 60,
  stepTitleMaxLength: 200,
  stepBodyMaxLength: 8000,
  maxResourceTypes: 40,
  noteMaxLength: 4000,
  summaryMaxLength: 8000,
} as const;

/**
 * Validate a runbook as the editor and the API both see it.
 *
 * Returns the first problem as a sentence, or null. One message rather than a
 * list because the editor shows it above the save button, and a list there
 * reads as a wall.
 */
export function validateRunbookInput(input: RunbookInput): string | null {
  const name = input.name?.trim() ?? "";
  if (!name) return "A name is required.";
  if (name.length > RUNBOOK_LIMITS.nameMaxLength) {
    return `Name must be ${RUNBOOK_LIMITS.nameMaxLength} characters or fewer.`;
  }
  if ((input.description?.length ?? 0) > RUNBOOK_LIMITS.descriptionMaxLength) {
    return `Description must be ${RUNBOOK_LIMITS.descriptionMaxLength} characters or fewer.`;
  }
  if ((input.resourceTypeIds?.length ?? 0) > RUNBOOK_LIMITS.maxResourceTypes) {
    return `A runbook may name at most ${RUNBOOK_LIMITS.maxResourceTypes} resource types.`;
  }
  if (input.tagValue != null && !input.tagKey) {
    return "A tag value needs a tag key.";
  }
  const steps = input.steps ?? [];
  if (steps.length > RUNBOOK_LIMITS.maxSteps) {
    return `A runbook may have at most ${RUNBOOK_LIMITS.maxSteps} steps.`;
  }
  for (const [index, step] of steps.entries()) {
    const problem = validateRunbookStep(step, index);
    if (problem) return problem;
  }
  return null;
}

function validateRunbookStep(step: RunbookStepInput, index: number): string | null {
  const position = index + 1;
  const title = step.title?.trim() ?? "";
  if (!title) return `Step ${position} needs a title.`;
  if (title.length > RUNBOOK_LIMITS.stepTitleMaxLength) {
    return `Step ${position}'s title must be ${RUNBOOK_LIMITS.stepTitleMaxLength} characters or fewer.`;
  }
  if ((step.body?.length ?? 0) > RUNBOOK_LIMITS.stepBodyMaxLength) {
    return `Step ${position} is too long (${RUNBOOK_LIMITS.stepBodyMaxLength} characters maximum).`;
  }
  if (step.kind === "workflow" && !step.workflowId) {
    return `Step ${position} runs a workflow, so it needs one selected.`;
  }
  if (step.kind === "link") {
    if (!step.url) return `Step ${position} is a link, so it needs a URL.`;
    if (!isSafeRunbookUrl(step.url)) {
      return `Step ${position}'s URL must be an https:// address.`;
    }
  }
  return null;
}

/**
 * Only `https:`.
 *
 * A runbook is authored by one colleague and clicked by another mid-incident,
 * which is the worst possible moment to be discerning about a link. `javascript:`
 * is the obvious attack; plain `http:` is barred too, because the one thing a
 * runbook link reliably points at is an internal console.
 */
export function isSafeRunbookUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export interface RunbookProgress {
  total: number;
  done: number;
  skipped: number;
  failed: number;
  pending: number;
  /** 0–100 over *settled* steps: done, skipped and failed all count as settled. */
  percent: number;
}

/**
 * How far through a run is.
 *
 * A skipped step counts as settled, not as done. Anything else would let a
 * responder reach 100% by skipping everything, and the number people glance at
 * has to mean "nothing is still waiting on me".
 */
export function runbookProgress(steps: readonly RunbookRunStep[]): RunbookProgress {
  const total = steps.length;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.status === "done") done += 1;
    else if (step.status === "skipped") skipped += 1;
    else if (step.status === "failed") failed += 1;
  }
  const settled = done + skipped + failed;
  return {
    total,
    done,
    skipped,
    failed,
    pending: total - settled,
    percent: total === 0 ? 0 : Math.round((settled / total) * 100),
  };
}

/** The next step still waiting on somebody, or null when nothing is. */
export function nextPendingStep(steps: readonly RunbookRunStep[]): RunbookRunStep | null {
  return steps.find((step) => step.status === "pending") ?? null;
}

export interface RunbookMatchTarget {
  resourceTypeId: string;
  /** The resource's tags, lower-cased keys. Empty when it has none. */
  tags?: Record<string, string> | undefined;
}

/**
 * Does this runbook apply to that resource?
 *
 * Two independent narrowings — type and one tag — rather than a query
 * language, the `backup_policies` selector shape and for the same reason: those
 * are the two axes people reason about, and a runbook with an empty selector
 * applying to everything is the useful shape for an org's first one.
 *
 * The tag key is matched case-insensitively (providers disagree about case) and
 * the value exactly (a value is a value).
 */
export function runbookMatchesResource(
  runbook: Pick<Runbook, "resourceTypeIds" | "tagKey" | "tagValue" | "enabled">,
  target: RunbookMatchTarget,
): boolean {
  if (!runbook.enabled) return false;
  if (
    runbook.resourceTypeIds.length > 0 &&
    !runbook.resourceTypeIds.includes(target.resourceTypeId)
  ) {
    return false;
  }
  if (!runbook.tagKey) return true;
  const tags = target.tags ?? {};
  const key = runbook.tagKey.toLowerCase();
  const found = Object.entries(tags).find(([tagKey]) => tagKey.toLowerCase() === key);
  if (!found) return false;
  return runbook.tagValue == null || found[1] === runbook.tagValue;
}

/**
 * Turn edited steps into stored ones, assigning ids to new steps.
 *
 * `makeId` is injected rather than imported so this stays pure — the server
 * passes `randomUUID`, tests pass a counter.
 */
export function normalizeRunbookSteps(
  steps: readonly RunbookStepInput[],
  makeId: () => string,
): RunbookStep[] {
  return steps.map((step) => ({
    id: step.id ?? makeId(),
    kind: step.kind,
    title: step.title.trim(),
    body: step.body?.trim() ?? "",
    // The reference for the *other* kind is dropped rather than carried:
    // a step switched from link to workflow that kept its URL would render a
    // button pointing somewhere nobody meant.
    ...(step.kind === "workflow" && step.workflowId ? { workflowId: step.workflowId } : {}),
    ...(step.kind === "link" && step.url ? { url: step.url } : {}),
  }));
}
