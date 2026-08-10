// The Jira filing affordance grew a second tracker (Linear) and moved to
// `../issue-filing/`, where the provider, button, and modal are tracker-aware.
// These re-exports keep the original Jira-shaped surface — provider, hook,
// button, modal — working unchanged for anything that imported it from here.
export {
  JiraFilingProvider,
  useJiraFiling,
  type JiraFilingApi,
  type JiraFilingHostProps,
} from "../issue-filing/host.js";
export {
  FileJiraIssueButton,
  type FileJiraIssueButtonProps,
} from "../issue-filing/FileIssueButton.js";
export {
  FileJiraIssueModal,
  type FileJiraIssueModalProps,
} from "../issue-filing/FileIssueModal.js";
