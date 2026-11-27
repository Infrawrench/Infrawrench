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

/** Short usernames, which a person pays for once (client-core `git-forge.ts`). */
export {
  GIT_SHORT_USERNAME_MAX_LENGTH as SHORT_USERNAME_MAX_LENGTH,
  GIT_SHORT_USERNAME_PRICE_CENTS as SHORT_USERNAME_PRICE_CENTS,
  GIT_SHORT_USERNAME_PRICE_LABEL as SHORT_USERNAME_PRICE_LABEL,
  GIT_SHORT_USERNAME_PAYMENT_REQUIRED as SHORT_USERNAME_PAYMENT_REQUIRED,
  GIT_USERNAME_HOLD_MINUTES as USERNAME_HOLD_MINUTES,
  GIT_USERNAME_CHECKOUT_PATH as USERNAME_CHECKOUT_PATH,
  GIT_USERNAME_CHECKOUT_PARAM as USERNAME_CHECKOUT_PARAM,
  gitUsernamePriceCents as usernamePriceCents,
} from "@infrawrench/client-core";

/**
 * A workspace set up from here: an Infrawrench organisation on the Pro plan,
 * offered to someone who belongs to none (client-core `git-forge.ts`).
 */
export {
  GIT_WORKSPACE_CHECKOUT_PATH as WORKSPACE_CHECKOUT_PATH,
  GIT_WORKSPACE_CHECKOUT_PARAM as WORKSPACE_CHECKOUT_PARAM,
  GIT_WORKSPACE_PRICE_LABEL as WORKSPACE_PRICE_LABEL,
  GIT_WORKSPACE_NAME_MAX_LENGTH as WORKSPACE_NAME_MAX_LENGTH,
  gitWorkspaceNameProblem as workspaceNameProblem,
} from "@infrawrench/client-core";
