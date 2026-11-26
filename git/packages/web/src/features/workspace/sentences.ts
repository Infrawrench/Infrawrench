/**
 * The sentences the home page and its rows are made of. Each is computed
 * from what the API answered, so none of them says more than the data does.
 */
import type {
  ActivityEvent,
  ChangeState,
  SuggestionReason,
  WorkspaceHome,
} from "@infrawrench/git-contract";
import { plural } from "../../lib/format";

/** `Your team has 15 active branches`, `You have 1 active branch`, `No active branches`. */
export function headline(home: Pick<WorkspaceHome, "activeBranches" | "shared">): string {
  const count = home.activeBranches;
  if (count === 0) return "No active branches";
  const branches = `${count} active ${count === 1 ? "branch" : "branches"}`;
  return home.shared ? `Your team has ${branches}` : `You have ${branches}`;
}

/** `a`, `a and b`, `a, b, and c`, `a, b, c, and 2 more`. */
export function listOf(names: ReadonlyArray<string>, most = 3): string {
  const shown = names.slice(0, most);
  const rest = names.length - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

const WINDOW: Record<number, string> = { 1: "day", 7: "week", 30: "30 days" };
export const windowName = (days: number): string => WINDOW[days] ?? `${days} days`;
export const windowLabel = (days: number): string =>
  days === 1 ? "Last 24 hours" : `Last ${days} days`;

/** `In the last week, your team has pushed changes to web, worker, and infra.` */
export function pushedSentence(home: Pick<WorkspaceHome, "pushed" | "shared">): string {
  const { days, repositories } = home.pushed;
  if (repositories.length === 0) return `Nothing was pushed in the last ${windowName(days)}.`;
  const who = home.shared ? "your team has" : "you have";
  const names = repositories.map((repository) => repository.name);
  return `In the last ${windowName(days)}, ${who} pushed changes to ${listOf(names)}.`;
}

/** What a state's icon says. */
export const CHANGE_STATE_LABEL: Record<ChangeState, string> = {
  agent_working: "Agent working",
  needs_review: "Needs review",
  changes_requested: "Changes requested",
  approved: "Approved",
  merged: "Merged",
  closed: "Closed",
};

/** Lines a reviewer gets through in a minute, for the estimate a suggestion shows. */
const LINES_A_MINUTE = 40;

/** How long reading a change takes, from its size: `1m review`, `25m review`, `1h+ review`. */
export function reviewTime(size: { additions: number; deletions: number }): string {
  const minutes = Math.max(1, Math.round((size.additions + size.deletions) / LINES_A_MINUTE));
  return minutes >= 60 ? "1h+ review" : `${minutes}m review`;
}

/** Why a branch is suggested: the words, and the part of them to set apart. */
export function reasonText(
  reason: SuggestionReason,
  repository: string,
): { text: string; strong: string | null } {
  switch (reason.kind) {
    case "assigned":
      return { text: "Assigned to you", strong: null };
    case "reviewed_before":
      return {
        text: "You reviewed",
        strong: reason.version === null ? null : `v${reason.version}`,
      };
    case "commented":
      return reason.version === null
        ? { text: "You commented", strong: null }
        : { text: "You commented on", strong: `v${reason.version}` };
    case "pushes_to_repository":
      return { text: "Because you push to", strong: repository };
  }
}

/** What happened, between who did it and what it happened to. */
export function activityVerb(event: ActivityEvent): string {
  switch (event.type) {
    case "pushed":
      return event.version === null ? "pushed to" : `pushed v${event.version} to`;
    case "approved":
      return "approved";
    case "changes_requested":
      return "requested changes on";
    case "commented":
      return "reviewed";
    case "merged":
      return "merged";
    case "findings": {
      const { found, mustFix } = event.findings ?? { found: 0, mustFix: 0 };
      return mustFix > 0 ? `found ${mustFix} must fix on` : `found ${plural(found, "finding")} on`;
    }
  }
}

/** Who an event names first: the agent that pushed, the person, or the review agents. */
export function activityActor(event: ActivityEvent): string {
  if (event.type === "findings") return "Review agents";
  if (event.agent !== null) return event.agent;
  return event.actor?.displayName ?? event.actor?.username ?? "Someone";
}
