import { useState } from "react";
import {
  buildJiraIssueDraft,
  type BuildJiraIssueDraftArgs,
  type JiraSourceKind,
} from "@infrawrench/client-core";

import { FileJiraIssueModal } from "./FileJiraIssueModal.js";
import { useJiraFiling } from "./host.js";

export interface FileJiraIssueButtonProps {
  sourceKind: JiraSourceKind;
  /** The finding's own id — what the link row is keyed on. */
  sourceId: string;
  /** Everything needed to prefill the issue. Built by the calling list. */
  draft: Omit<BuildJiraIssueDraftArgs, "sourceKind">;
  className?: string;
}

/**
 * The one "File a Jira issue" affordance, dropped onto any findings row.
 *
 * Three states, and the third is the reason this is a shared component rather
 * than a button per list:
 *
 *   - already filed → a link to the issue, never a second offer
 *   - filable       → the button
 *   - otherwise     → nothing at all
 *
 * "Otherwise" covers no provider mounted, Jira not connected, and the caller
 * lacking `jira:write`. Rendering a disabled button in those cases would be a
 * dead control advertising a feature the user cannot reach; rendering nothing
 * is the honest answer.
 */
export function FileJiraIssueButton({
  sourceKind,
  sourceId,
  draft,
  className,
}: FileJiraIssueButtonProps) {
  const filing = useJiraFiling();
  const [open, setOpen] = useState(false);

  if (!filing) return null;

  const existing = filing.linkFor(sourceKind, sourceId);
  if (existing) {
    return (
      <button
        type="button"
        onClick={() => filing.openExternal(existing.issueUrl)}
        title={`Filed as ${existing.issueKey}`}
        className={
          className ?? "text-xs font-medium text-blue-500 hover:text-blue-400 whitespace-nowrap"
        }
      >
        {existing.issueKey}
      </button>
    );
  }

  if (!filing.integration || !filing.canFile) return null;

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
        File in Jira
      </button>
      {open && (
        <FileJiraIssueModal
          sourceKind={sourceKind}
          sourceId={sourceId}
          draft={buildJiraIssueDraft({ sourceKind, ...draft })}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
