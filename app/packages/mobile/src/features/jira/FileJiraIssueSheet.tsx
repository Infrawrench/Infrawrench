import type { BuildJiraIssueDraftArgs, JiraSourceKind } from "@infrawrench/client-core";
import { FileIssueSheet } from "../issue-filing/FileIssueSheet";

/**
 * Jira-locked mount of the tracker-neutral {@link FileIssueSheet}, kept so
 * callers wired before Linear existed keep working unchanged. New callers
 * should render `FileIssueSheet` with the trackers from `useFilableTrackers`.
 *
 * @deprecated Use `FileIssueSheet` from `@/features/issue-filing/FileIssueSheet`.
 */
export function FileJiraIssueSheet(props: {
  visible: boolean;
  sourceKind: JiraSourceKind;
  sourceId: string;
  draft: Omit<BuildJiraIssueDraftArgs, "sourceKind">;
  onClose: () => void;
}) {
  return <FileIssueSheet {...props} trackers={["jira"]} />;
}
