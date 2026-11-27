import type { OpenIssue, OpenPullRequest } from "./decide.js";
import type { ChangeForm } from "./render.js";

/**
 * Everything the watcher does where changes and issues are tracked, so that the logic
 * above it can be tested and the place can be swapped: GitHub (`github.ts`) or the forge
 * (`forge.ts`). The names are GitHub's because it came first. On the forge a "pull
 * request" is a branch's page: see `forge.ts` for what each method means there.
 */
export interface TrackerPort {
  /** What a change is called here. A pull request when left out. */
  readonly changeForm?: ChangeForm;
  listPullRequests(): Promise<OpenPullRequest[]>;
  listIssues(): Promise<OpenIssue[]>;
  /** Called after the branch has been pushed. Answers a link to the change. */
  createPullRequest(branch: string, title: string, body: string): Promise<string>;
  editPullRequest(number: number, body: string): Promise<void>;
  /** Also deletes the branch. */
  closePullRequest(number: number, comment: string): Promise<void>;
  /** Labelled `bug`. Answers a link to the issue. */
  createIssue(title: string, body: string): Promise<string>;
  editIssue(number: number, body: string): Promise<void>;
  closeIssue(number: number, comment: string): Promise<void>;
}
