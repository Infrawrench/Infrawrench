/**
 * The host half of reversible failure actions: which ones a resource type
 * supports, and running their three steps through the plugin.
 *
 * Nothing here knows a provider. A type supports what its plugin declares in
 * `failureActions`, plus `stop` when it declares a `lifecycle` pair (run
 * through `invokeAction`, as the sleep schedules do). Every call goes through
 * the account's `HostPluginClient`, which runs on call inside the egress
 * scope.
 */
import {
  failureActionsForType,
  isLifecycleFailureAction,
  type FailureActionDeclaration,
  type FailureUndoState,
  type LifecycleActionsDeclaration,
  type PreparedFailure,
  type ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { getOrgAccountClient } from "../org-accounts";
import { getPlugin } from "../plugin-loader";

/** A target as the actions need it. */
export interface FailureTarget {
  organizationId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
  actionId: string;
}

/** The resource type definition, or null when the plugin or type is gone. */
export async function resourceTypeFor(
  pluginId: string,
  resourceTypeId: string,
): Promise<ResourceTypeDefinition | null> {
  const loaded = await getPlugin(pluginId);
  return loaded?.plugin.resourceTypes.find((rt) => rt.id === resourceTypeId) ?? null;
}

/** Every failure action instances of the type support; empty for an unknown type. */
export async function failureActionsFor(
  pluginId: string,
  resourceTypeId: string,
): Promise<FailureActionDeclaration[]> {
  const type = await resourceTypeFor(pluginId, resourceTypeId);
  return type ? failureActionsForType(type) : [];
}

function stateMatches(value: unknown, values: readonly string[] | undefined): boolean {
  if (typeof value !== "string" || !values) return false;
  const lowered = value.toLowerCase();
  return values.some((v) => v.toLowerCase() === lowered);
}

async function clientFor(target: FailureTarget) {
  const ctx = await getOrgAccountClient(target.accountId, target.organizationId);
  if (!ctx) throw new Error("The account is gone or its plugin failed to load");
  return ctx.client;
}

async function lifecycleOf(target: FailureTarget): Promise<LifecycleActionsDeclaration | null> {
  const type = await resourceTypeFor(target.pluginId, target.resourceTypeId);
  if (!type) throw new Error(`${target.pluginId}/${target.resourceTypeId} is no longer a known type`);
  if (!failureActionsForType(type).some((a) => a.id === target.actionId)) {
    throw new Error(`The type no longer supports the failure action "${target.actionId}"`);
  }
  return isLifecycleFailureAction(type, target.actionId) ? (type.lifecycle ?? null) : null;
}

/**
 * Read what the undo will need, changing nothing. For a lifecycle stop that is
 * the live run state: an instance already stopped is left alone.
 */
export async function prepareFailureTarget(target: FailureTarget): Promise<PreparedFailure> {
  const lifecycle = await lifecycleOf(target);
  const client = await clientFor(target);
  if (lifecycle) {
    const live = await client.getResource(target.resourceTypeId, target.resourceId, target.accountId);
    const key = lifecycle.statusFieldKey;
    const value = key ? live.fields[key] : undefined;
    return {
      undo: {},
      alreadyInEffect: stateMatches(value, lifecycle.stoppedValues),
      ...(value !== undefined && value !== null ? { currentState: String(value) } : {}),
    };
  }
  if (!client.prepareFailure) throw new Error(`${target.pluginId} cannot prepare failures`);
  return client.prepareFailure(
    target.resourceTypeId,
    target.resourceId,
    target.accountId,
    target.actionId,
  );
}

/** Inject the failure. */
export async function injectFailureTarget(target: FailureTarget): Promise<void> {
  const lifecycle = await lifecycleOf(target);
  const client = await clientFor(target);
  if (lifecycle) {
    if (!client.invokeAction) throw new Error(`${target.pluginId} cannot invoke actions`);
    await client.invokeAction(
      target.resourceTypeId,
      target.resourceId,
      lifecycle.stopActionId,
      target.accountId,
    );
    return;
  }
  if (!client.injectFailure) throw new Error(`${target.pluginId} cannot inject failures`);
  await client.injectFailure(
    target.resourceTypeId,
    target.resourceId,
    target.accountId,
    target.actionId,
  );
}

/**
 * Undo the failure. For a lifecycle stop, a resource already running is left
 * as it is: a start on a running instance is an error at some providers.
 */
export async function undoFailureTarget(
  target: FailureTarget,
  undo: FailureUndoState,
): Promise<void> {
  const lifecycle = await lifecycleOf(target);
  const client = await clientFor(target);
  if (lifecycle) {
    if (!client.invokeAction) throw new Error(`${target.pluginId} cannot invoke actions`);
    if (lifecycle.statusFieldKey && lifecycle.runningValues) {
      try {
        const live = await client.getResource(
          target.resourceTypeId,
          target.resourceId,
          target.accountId,
        );
        if (stateMatches(live.fields[lifecycle.statusFieldKey], lifecycle.runningValues)) return;
      } catch {
        // Best-effort: fall through to the start.
      }
    }
    await client.invokeAction(
      target.resourceTypeId,
      target.resourceId,
      lifecycle.startActionId,
      target.accountId,
    );
    return;
  }
  if (!client.undoFailure) throw new Error(`${target.pluginId} cannot undo failures`);
  await client.undoFailure(
    target.resourceTypeId,
    target.resourceId,
    target.accountId,
    target.actionId,
    undo,
  );
}
