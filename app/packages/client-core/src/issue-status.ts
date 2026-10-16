/**
 * Live status of filed issues, across Jira, Linear and GitHub.
 *
 * Filing a finding used to be the end of the story: the row showed `OPS-412`
 * and nothing about whether anybody had picked it up. Each link row now also
 * carries the issue's current status, its tracker-neutral category, the
 * assignee and when the issue last changed, kept fresh by tracker webhooks
 * where the org set them up and by a periodic poll everywhere else.
 *
 * The three trackers model progress differently, so the stored status keeps
 * the tracker's own wording (`In Review`, `Backlog`, `closed`) and a
 * {@link IssueStatusCategory} beside it that every surface can colour and
 * reason about without knowing which tracker it came from:
 *
 *   Jira    statusCategory.key   new → todo, indeterminate → in_progress,
 *                                done → done
 *   Linear  state.type           triage/backlog/unstarted → todo,
 *                                started → in_progress, completed → done,
 *                                canceled/duplicate → canceled
 *   GitHub  state + state_reason open → todo, closed completed → done,
 *                                closed not_planned/duplicate → canceled
 *
 * Everything here is pure: the server's sync, the poll pass, the webhook
 * receivers and every client share these mappers, so "Done" means the same
 * thing on a phone as it does in the event payload.
 */

/** Tracker-neutral progress of an issue. */
export const ISSUE_STATUS_CATEGORIES = ["todo", "in_progress", "done", "canceled"] as const;

export type IssueStatusCategory = (typeof ISSUE_STATUS_CATEGORIES)[number];

export function isIssueStatusCategory(value: unknown): value is IssueStatusCategory {
  return (
    typeof value === "string" && (ISSUE_STATUS_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * The status columns every link row carries. All null until the first sync
 * (a link filed before status sync existed, or one the tracker has not been
 * asked about yet), which surfaces render as "no status" rather than a guess.
 * Optional so a client a release ahead of its server keeps decoding.
 */
export interface IssueStatusFields {
  /** The tracker's own status name, e.g. `In Progress`, `Backlog`, `closed`. */
  status?: string | null | undefined;
  statusCategory?: IssueStatusCategory | null | undefined;
  /** Display name (Jira, Linear) or login (GitHub) of the assignee. */
  assignee?: string | null | undefined;
  /** When the issue itself last changed, as the tracker reports it. */
  issueUpdatedAt?: string | null | undefined;
  /** When Infrawrench last learned the status (webhook or poll). */
  statusSyncedAt?: string | null | undefined;
}

/** A status reading for one issue, as a sync produces it. */
export interface IssueStatusSnapshot {
  status: string | null;
  statusCategory: IssueStatusCategory | null;
  assignee: string | null;
  issueUpdatedAt: string | null;
}

/** Jira `statusCategory.key` → category. `undefined` (and anything new) is unknown. */
export function jiraStatusCategory(key: string | null | undefined): IssueStatusCategory | null {
  switch (key) {
    case "new":
      return "todo";
    case "indeterminate":
      return "in_progress";
    case "done":
      return "done";
    default:
      return null;
  }
}

/** Linear `WorkflowState.type` → category. */
export function linearStatusCategory(type: string | null | undefined): IssueStatusCategory | null {
  switch (type) {
    case "triage":
    case "backlog":
    case "unstarted":
      return "todo";
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "canceled":
    case "duplicate":
      return "canceled";
    default:
      return null;
  }
}

/**
 * GitHub issue `state` + `state_reason` → category. A closed issue with no
 * reason (closed before GitHub had reasons, or by a commit keyword) counts as
 * done: that is what closing meant before `not_planned` existed.
 */
export function githubStatusCategory(
  state: string | null | undefined,
  stateReason: string | null | undefined,
): IssueStatusCategory | null {
  if (state === "open") return "todo";
  if (state !== "closed") return null;
  return stateReason === "not_planned" || stateReason === "duplicate" ? "canceled" : "done";
}

/** The status name a GitHub issue is shown with: its state, refined by the close reason. */
export function githubStatusName(
  state: string | null | undefined,
  stateReason: string | null | undefined,
): string | null {
  if (state === "open") return "Open";
  if (state !== "closed") return null;
  if (stateReason === "not_planned") return "Closed as not planned";
  if (stateReason === "duplicate") return "Closed as duplicate";
  return "Closed";
}

/** Whether the issue is finished, one way or the other. */
export function isIssueStatusClosed(category: IssueStatusCategory | null | undefined): boolean {
  return category === "done" || category === "canceled";
}

/**
 * Whether a new reading is a change worth telling anyone about: a different
 * status name or category. The first reading of a link (nothing known before)
 * is a baseline, not a change, so a backfill of a hundred old links does not
 * fire a hundred events.
 */
export function issueStatusChanged(
  previous: Pick<IssueStatusSnapshot, "status" | "statusCategory">,
  next: Pick<IssueStatusSnapshot, "status" | "statusCategory">,
): boolean {
  if (previous.status === null && previous.statusCategory === null) return false;
  return previous.status !== next.status || previous.statusCategory !== next.statusCategory;
}

/**
 * Whether a reading moved the issue *into* done: the transition that may mark
 * the finding resolved. A reading that was already done, or one that is done
 * on first sight, does not count; the org turned the option on for issues that
 * get finished, not to sweep up history.
 */
export function issueBecameDone(
  previous: Pick<IssueStatusSnapshot, "statusCategory">,
  next: Pick<IssueStatusSnapshot, "statusCategory">,
): boolean {
  return (
    next.statusCategory === "done" &&
    previous.statusCategory !== null &&
    previous.statusCategory !== "done"
  );
}

/**
 * Whether a reading is at least as new as what is stored. Webhooks retry and
 * can arrive out of order, and a poll can race a webhook; an older reading
 * must never overwrite a newer one. Unknown timestamps on either side accept
 * the reading (there is nothing to compare).
 */
export function isIssueReadingFresh(
  storedUpdatedAt: string | Date | null | undefined,
  readingUpdatedAt: string | null | undefined,
): boolean {
  if (!storedUpdatedAt || !readingUpdatedAt) return true;
  const stored =
    storedUpdatedAt instanceof Date ? storedUpdatedAt.getTime() : Date.parse(storedUpdatedAt);
  const reading = Date.parse(readingUpdatedAt);
  if (Number.isNaN(stored) || Number.isNaN(reading)) return true;
  return reading >= stored;
}

/**
 * The tracker-neutral handle of an issue, for events and lists: `OPS-412`,
 * `ENG-123`, `acme/infra#12`.
 */
export function issueHandle(
  link:
    | { tracker: "jira"; issueKey: string }
    | { tracker: "linear"; issueIdentifier: string }
    | { tracker: "github"; repo: string; issueNumber: number },
): string {
  switch (link.tracker) {
    case "jira":
      return link.issueKey;
    case "linear":
      return link.issueIdentifier;
    case "github":
      return `${link.repo}#${link.issueNumber}`;
  }
}

/** How a tracker's webhook for live status is set up, as the settings section shows it. */
export type IssueWebhookMode = "registered" | "manual";

/**
 * The live-status webhook state of a Jira or Linear connection. `mode` null
 * means none: statuses still refresh, through the poll.
 */
export interface IssueWebhookState {
  mode: IssueWebhookMode | null;
  /** The receiver URL to give the tracker; null when no webhook is set up. */
  url: string | null;
  /** When the last signed delivery arrived; null when none has. */
  lastDeliveryAt: string | null;
}

/**
 * The reply to setting up a webhook. `secret` is present only when the person
 * must paste it into the tracker themselves (Jira, manual mode), and it is
 * returned this once: it is stored encrypted and never read back.
 */
export interface IssueWebhookSetupResult {
  webhook: IssueWebhookState;
  secret?: string | undefined;
  /**
   * Why automatic registration fell back to manual, in the tracker's own
   * words (usually "the account is not an admin").
   */
  fallbackReason?: string | undefined;
}

/** The reply to "Refresh statuses": how many links were asked about and how many changed. */
export interface IssueStatusRefreshResult {
  checked: number;
  changed: number;
}
