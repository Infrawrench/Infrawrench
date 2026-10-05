import { useState } from "react";
import { useGT } from "gt-react";
import {
  buildJiraIssueDraft,
  type BuildJiraIssueDraftArgs,
  type JiraSourceKind,
} from "@infrawrench/client-core";

import { FileIssueModal } from "./FileIssueModal.js";
import { useIssueFiling } from "./host.js";

export interface FileIssueButtonProps {
  sourceKind: JiraSourceKind;
  /** The finding's own id: what the link rows are keyed on. */
  sourceId: string;
  /** Everything needed to prefill the issue. Built by the calling list. */
  draft: Omit<BuildJiraIssueDraftArgs, "sourceKind">;
  /** The finding's resource, for GitHub's repository routing and Terraform line. */
  resourceId?: string | undefined;
  /** Monthly money at stake, shown in a GitHub issue body. */
  monthlyCost?: { amount: number; currency: string } | undefined;
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
 *                     link; both, when the finding was filed to both), never
 *                     a second offer for that tracker
 *   - filable       → one button, labelled by what is connected: "File in
 *                     Jira" or "File in Linear" when exactly one tracker is
 *                     available, "File an issue" (with the tracker chosen in
 *                     the modal) when both are
 *   - otherwise     → nothing at all
 *
 * "Otherwise" covers no provider mounted, no tracker connected, and the caller
 * lacking every `:write`. Rendering a disabled button in those cases would be
 * a dead control advertising a feature the user cannot reach; rendering
 * nothing is the honest answer.
 */
export function FileIssueButton({
  sourceKind,
  sourceId,
  draft,
  resourceId,
  monthlyCost,
  className,
}: FileIssueButtonProps) {
  const gt = useGT();
  const filing = useIssueFiling();
  const [open, setOpen] = useState(false);

  if (!filing) return null;

  const links = filing.linksFor(sourceKind, sourceId);
  // An open GitHub issue counts as filed; a closed one (the finding resolved,
  // then came back) offers filing again, which the server turns into a new
  // issue rather than a comment on the closed one.
  const github = links.github?.state === "open" ? links.github : undefined;
  if (links.jira || links.linear || github) {
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
        {github && (
          <button
            type="button"
            onClick={() => filing.openExternal(github.issueUrl)}
            title={gt("Filed in GitHub as {repo}#{number}", {
              repo: github.repo,
              number: github.issueNumber,
            })}
            className={className ?? badgeClass}
          >
            #{github.issueNumber}
          </button>
        )}
      </span>
    );
  }

  const trackers = filing.filableTrackers;
  if (trackers.length === 0) return null;

  const label =
    trackers.length > 1
      ? gt("File an issue")
      : trackers[0] === "jira"
        ? gt("File in Jira")
        : trackers[0] === "linear"
          ? gt("File in Linear")
          : gt("File in GitHub");

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
          finding={{ ...draft, resourceId, monthlyCost }}
          trackers={trackers}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
