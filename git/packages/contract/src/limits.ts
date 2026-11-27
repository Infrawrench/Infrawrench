/**
 * What a namespace may hold by its owner's plan, the sentence that refuses
 * one more private repository, and the one that refuses an organisation's
 * namespace without a paid plan. They live in
 * `@infrawrench/client-core` (`git-forge.ts`), where the app's Settings > Git
 * words the same numbers; this module re-exports them for the forge.
 */
export {
  GIT_FORGE_LIMITS as FORGE_LIMITS,
  gitPrivateRepositoryLimitMessage as privateRepositoryRefusal,
  GIT_FORGE_NAMESPACE_PLAN_REQUIRED as NAMESPACE_PLAN_REQUIRED,
  gitNamespaceClaimRefusal as namespaceClaimRefusal,
  type GitForgePlan as ForgePlan,
} from "@infrawrench/client-core";
