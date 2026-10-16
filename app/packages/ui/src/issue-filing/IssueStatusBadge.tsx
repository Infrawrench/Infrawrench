import { useGT } from "gt-react";
import type { IssueStatusCategory, IssueStatusFields } from "@infrawrench/client-core";

import { useDataString } from "../i18n/data-strings.js";

/** Dot colour per category; status colours are reserved for state, as elsewhere. */
const DOT: Record<IssueStatusCategory, string> = {
  todo: "bg-on-surface-faint",
  in_progress: "bg-info",
  done: "bg-success",
  canceled: "bg-on-surface-faint opacity-50",
};

/**
 * A filed issue's live status beside its link: a coloured dot and the
 * tracker's own status name (`In Review`, `Backlog`, `Closed`), with the
 * assignee and the last change in the tooltip. Renders nothing until the
 * first sync has said anything, rather than guessing "To do".
 */
export function IssueStatusBadge({
  link,
  className,
}: {
  link: IssueStatusFields;
  className?: string | undefined;
}) {
  const gt = useGT();
  const dataString = useDataString();
  const category = link.statusCategory ?? null;
  if (!link.status && !category) return null;

  const fallback =
    category === "todo"
      ? gt("To do")
      : category === "in_progress"
        ? gt("In progress")
        : category === "done"
          ? gt("Done")
          : gt("Canceled");
  // The tracker's own status name is data (a team's workflow), translated
  // only when a catalog happens to have it.
  const label = link.status ? dataString(link.status) : fallback;
  const details = [
    link.assignee ? gt("Assigned to {name}", { name: link.assignee }) : gt("Unassigned"),
    link.issueUpdatedAt
      ? gt("Updated {date}", { date: new Date(link.issueUpdatedAt).toLocaleString() })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      title={details}
      className={
        className ??
        "inline-flex items-center gap-1 text-[11px] text-on-surface-muted whitespace-nowrap"
      }
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${category ? DOT[category] : "bg-on-surface-faint"}`}
      />
      {label}
    </span>
  );
}
