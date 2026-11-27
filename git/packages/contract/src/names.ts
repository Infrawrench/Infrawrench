/**
 * The naming rules for namespaces and repositories, shared by the forms that
 * check a name as it is typed and the server that refuses it (git/README.md
 * "Identity, namespaces, access").
 *
 * They live in `@infrawrench/client-core` (`git-names.ts`), because the app
 * claims and renames an organisation's namespace by the same rules; this
 * module re-exports them so the forge names them as it always has.
 */
export {
  GIT_NAME_MAX_LENGTH as NAME_MAX_LENGTH,
  GIT_REPOSITORY_NAME_MAX_LENGTH as REPOSITORY_NAME_MAX_LENGTH,
  GIT_RESERVED_NAMESPACES as RESERVED_NAMESPACES,
  GIT_RESERVED_REPOSITORY_NAMES as RESERVED_REPOSITORY_NAMES,
  isValidGitRefName as isValidRefName,
  gitNameProblemMessage as nameProblemMessage,
  gitNamespaceSlugProblem as namespaceSlugProblem,
  gitRepositoryNameProblem as repositoryNameProblem,
  suggestGitSlug as suggestSlug,
  type GitNameProblem as NameProblem,
} from "@infrawrench/client-core";

/** What names a branch's page in a link and an API path (client-core `git-branch-key.ts`). */
export {
  formatGitBranchKey as formatBranchKey,
  gitBranchPagePath as branchPagePath,
  parseGitBranchKey as parseBranchKey,
  type GitBranchKey as ParsedBranchKey,
  type GitBranchKeyFork as BranchKeyFork,
} from "@infrawrench/client-core";

/**
 * The names Infrawrench CI writes a job's note commands under (client-core
 * `ci-notes.ts`): findings by the reviewer `ci:<pipeline>/<job>`, trace
 * entries by an agent of kind `ci`. The API refuses both to everyone else,
 * and the pages say "CI" by them.
 */
export {
  CI_AGENT_KIND,
  CI_REVIEWER_PREFIX,
  ciReviewerJob,
  isCiReviewer,
} from "@infrawrench/client-core";
