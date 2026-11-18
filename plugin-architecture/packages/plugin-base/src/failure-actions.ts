/**
 * Reversible failure actions: what a game day may do to a resource, and how
 * the host puts it back.
 *
 * A game day is a planned, controlled failure. The host (server-core
 * `game-days/`) injects one of these into a resource at the start of the
 * window and undoes it at the end, on "end now", on abort, or after a restart
 * mid-run. Everything that makes that safe hangs on the undo being reliable,
 * so a plugin declares an action here only when its undo restores the
 * resource to the state it was in before, with nothing lost: stopping an
 * instance (undo: start it), scaling a deployment to zero (undo: scale it back
 * to the count it had). Deleting, resizing down a disk, rotating a credential
 * or anything else whose undo is a re-create never belongs here.
 *
 * Two sources, one list:
 *
 * - A type that declares a `lifecycle` start/stop pair (the sleep schedules'
 *   declaration) gets a `stop` failure action for free: stop is the inject,
 *   start is the undo, both through `invokeAction`. Nothing extra to declare.
 * - Anything else is declared in `failureActions` on the resource type, and
 *   the plugin implements `prepareFailure`, `injectFailure` and `undoFailure`
 *   on its client (`RESOURCE_TYPE_REQUIREMENTS` holds it to that).
 *
 * The three methods are split so the undo survives a crash. The host calls
 * `prepareFailure` first, which only reads: it returns what the undo needs (a
 * replica count) and whether the failure is somehow already in effect. The
 * host stores that before it calls `injectFailure`, so a process that dies
 * between the provider call and the next database write still knows how to
 * put the resource back.
 */

/** One failure a game day can inject into instances of a resource type. */
export interface FailureActionDeclaration {
  /**
   * Stable id within the type, passed back to the client methods. `stop` is
   * reserved for the action derived from `lifecycle`; declaring it here
   * replaces the derived one.
   */
  id: string;
  /** What the action does, as a verb phrase: "Scale to zero replicas". */
  label: string;
  /** What undoing it does: "Scale back to the previous replica count". */
  undoLabel: string;
  /** One sentence on what the failure looks like from outside. */
  description?: string;
}

/**
 * What the undo needs, captured before the inject. A small JSON object the
 * host stores verbatim and hands back to `undoFailure`; its shape is the
 * plugin's business.
 */
export type FailureUndoState = Record<string, string | number | boolean | null>;

/** The answer to `prepareFailure`. */
export interface PreparedFailure {
  /** Handed back to `undoFailure` unchanged. */
  undo: FailureUndoState;
  /**
   * The failure is already in effect (the deployment is already at zero, the
   * instance already stopped). The host then neither injects nor undoes: the
   * resource was in that state before the game day and must be left in it.
   */
  alreadyInEffect: boolean;
  /** What the dry run shows about the current state: "3 replicas". */
  currentState?: string;
}

/** The `stop` action a `lifecycle` declaration implies. */
export const LIFECYCLE_STOP_FAILURE_ACTION: FailureActionDeclaration = {
  id: "stop",
  label: "Stop",
  undoLabel: "Start again",
  description: "The resource is stopped through the provider, as a sleep schedule would.",
};

/**
 * Every failure action instances of `type` support: the declared ones, plus
 * `stop` when the type has a `lifecycle` pair and does not declare its own.
 */
export function failureActionsForType(type: {
  failureActions?: FailureActionDeclaration[] | undefined;
  lifecycle?: unknown;
}): FailureActionDeclaration[] {
  const declared = type.failureActions ?? [];
  if (type.lifecycle && !declared.some((a) => a.id === LIFECYCLE_STOP_FAILURE_ACTION.id)) {
    return [LIFECYCLE_STOP_FAILURE_ACTION, ...declared];
  }
  return [...declared];
}

/**
 * Whether a failure action is the lifecycle-derived `stop`, which the host
 * runs through `invokeAction` rather than the failure methods.
 */
export function isLifecycleFailureAction(
  type: { failureActions?: FailureActionDeclaration[] | undefined; lifecycle?: unknown },
  actionId: string,
): boolean {
  return (
    actionId === LIFECYCLE_STOP_FAILURE_ACTION.id &&
    Boolean(type.lifecycle) &&
    !(type.failureActions ?? []).some((a) => a.id === actionId)
  );
}
