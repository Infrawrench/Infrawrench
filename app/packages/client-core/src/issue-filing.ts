/**
 * Cross-tracker issue filing — the shapes shared by every surface that offers
 * "file this finding as an issue" for whichever trackers the org connected.
 *
 * The per-tracker halves live in `./jira` and `./linear`; this module owns
 * only what spans both. It exists because the ui `IssueFilingProvider` and the
 * mobile `useIssueFiling` hooks are parallel implementations of the same
 * affordance (mobile cannot load the DOM component library), and the combined
 * vocabulary they agree on has to have one home.
 */
import type { JiraIssueLink } from "./jira";
import type { LinearIssueLink } from "./linear";

/** The trackers a finding can be filed to. */
export type IssueTracker = "jira" | "linear";

/** What a findings row knows about where it has already been filed. */
export interface IssueLinksForSource {
  jira?: JiraIssueLink | undefined;
  linear?: LinearIssueLink | undefined;
}
