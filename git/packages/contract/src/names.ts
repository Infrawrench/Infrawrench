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
