import { useState } from "react";
import {
  buildJiraIssueDraft,
  type BuildJiraIssueDraftArgs,
  type JiraSourceKind,
} from "@infrawrench/client-core";

import { FileIssueModal } from "./FileIssueModal.js";
import { useIssueFiling } from "./host.js";

export interface FileIssueButtonProps {
  sourceKind: JiraSourceKind;
  /** The finding's own id — what the link rows are keyed on. */
  sourceId: string;
  /** Everything needed to prefill the issue. Built by the calling list. */
  draft: Omit<BuildJiraIssueDraftArgs, "sourceKind">;
  className?: string;
}

const badgeClass = "text-xs font-medium text-info hover:text-info-strong whitespace-nowrap";

/**
 * The one tracker-aware filing affordance, dropped onto any findings row.
 *
 * Three states, and the third is the reason this is a shared component rather
 * than a button per list:
 *
 *   - already filed → a link to the issue (one badge per tracker that holds a
 *                     link — both, when the finding was filed to both), never
 *                     a second offer for that tracker
 *   - filable       → one button, labelled by what is connected: "File in
 *                     Jira" or "File in Linear" when exactly one tracker is
 *                     available, "File an issue" — with the tracker chosen in
 *                     the modal — when both are
 *   - otherwise     → nothing at all
 *
 * "Otherwise" covers no provider mounted, no tracker connected, and the caller
 * lacking every `:write`. Rendering a disabled button in those cases would be
 * a dead control advertising a feature the user cannot reach; rendering
 * nothing is the honest answer.
 */
export function FileIssueButton({ sourceKind, sourceId, draft, className }: FileIssueButtonProps) {
  const filing = useIssueFiling();
  const [open, setOpen] = useState(false);

  if (!filing) return null;

  const links = filing.linksFor(sourceKind, sourceId);
  if (links.jira || links.linear) {
    return (
      <span className="inline-flex items-center gap-2">
        {links.jira && (
          <button
            type="button"
            onClick={() => filing.openExternal(links.jira!.issueUrl)}
            title={`Filed in Jira as ${links.jira.issueKey}`}
            className={className ?? badgeClass}
          >
            {links.jira.issueKey}
          </button>
        )}
        {links.linear && (
          <button
            type="button"
            onClick={() => filing.openExternal(links.linear!.issueUrl)}
            title={`Filed in Linear as ${links.linear.issueIdentifier}`}
            className={className ?? badgeClass}
          >
            {links.linear.issueIdentifier}
          </button>
        )}
      </span>
    );
  }

  const trackers = filing.filableTrackers;
  if (trackers.length === 0) return null;

  const label =
    trackers.length > 1
      ? "File an issue"
      : trackers[0] === "jira"
        ? "File in Jira"
        : "File in Linear";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "text-xs text-on-surface-muted hover:text-on-surface-secondary whitespace-nowrap"
        }
      >
        {label}
      </button>
      {open && (
        <FileIssueModal
          sourceKind={sourceKind}
          sourceId={sourceId}
          draft={buildJiraIssueDraft({ sourceKind, ...draft })}
          trackers={trackers}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export interface FileJiraIssueButtonProps extends FileIssueButtonProps {}

/**
 * @deprecated The button has been tracker-aware since Linear landed; this
 * alias keeps older imports compiling. It is the same component — under a
 * provider with Linear connected it will offer Linear too.
 */
export const FileJiraIssueButton = FileIssueButton;
