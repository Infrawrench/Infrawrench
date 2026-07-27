/**
 * Create-flow dispatcher for the DigitalOcean plugin.
 *
 * The per-type form building and the POST bodies live in `./create-handlers/`,
 * one module per vendor domain — same shape the AWS plugin uses. Each module
 * returns `null` for a `typeId` it does not own; the first non-null result
 * wins, and every module declining is the "unsupported type" case. The arms
 * are mutually exclusive, so the order below is presentational only.
 *
 * This module is the stable import path: `client.ts` and the tests import
 * `DoCreateContext`, `estimateDoDatabaseMonthlyPrice`, `doGetCreateConfig` and
 * `doCreateResource` from here exactly as they always have.
 */
import type {
  CreateResourceConfig,
  ResourceCreateResult,
  ResourceInstance,
  ResourceWarning,
} from "@infrawrench/plugin-base";
import type {
  CreateHandler,
  DoCreateArgs,
  DoCreateContext,
  GetConfigHandler,
} from "./create-handlers/shared.js";
import { computeGetCreateConfig, computeCreateResource } from "./create-handlers/compute.js";
import { storageGetCreateConfig, storageCreateResource } from "./create-handlers/storage.js";
import { databaseGetCreateConfig, databaseCreateResource } from "./create-handlers/database.js";
import {
  networkingGetCreateConfig,
  networkingCreateResource,
} from "./create-handlers/networking.js";
import { projectGetCreateConfig, projectCreateResource } from "./create-handlers/project.js";
import { genaiGetCreateConfig, genaiCreateResource } from "./create-handlers/genai.js";

export type { DoCreateContext, DoCreateArgs } from "./create-handlers/shared.js";
export { estimateDoDatabaseMonthlyPrice } from "./create-handlers/database.js";

const getConfigHandlers: GetConfigHandler[] = [
  computeGetCreateConfig,
  storageGetCreateConfig,
  databaseGetCreateConfig,
  networkingGetCreateConfig,
  projectGetCreateConfig,
  genaiGetCreateConfig,
];

const createHandlers: CreateHandler[] = [
  computeCreateResource,
  storageCreateResource,
  databaseCreateResource,
  networkingCreateResource,
  projectCreateResource,
  genaiCreateResource,
];

export async function doGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  for (const handler of getConfigHandlers) {
    const result = await handler(ctx, typeId, parentResourceId);
    if (result !== null) return result;
  }
  throw new Error(`No create config for type "${typeId}"`);
}

export async function doCreateResource(
  ctx: DoCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceCreateResult> {
  const warnings: ResourceWarning[] = [];
  // Mutable cell — handlers that mint sidecar credentials (e.g. spaces-bucket
  // auto-creating an account-wide Spaces key) write into it, and the wrapper
  // forwards them up to the host as `credentialUpdates` on the result.
  const credentialUpdatesRef: { value?: Record<string, string> } = {};

  // When a child resource is created from its parent's detail page, the form
  // omits the parent-identifying field — recover it by parsing the parent's
  // `{accountId}:{typeId}:{externalId}` id. DO project ids are UUIDs; DO
  // domain ids are the domain name itself. Falls back to `fields["projectId"]`
  // when the form was opened from the account base and the user picked a
  // project explicitly via the build-helper-added field.
  const parentExternalId = parentResourceId
    ? parentResourceId.split(":").slice(2).join(":")
    : (fields["projectId"] ?? "");

  // For project-assignable types, build a synthetic parentResourceId from
  // the picked project so the new resource nests under its project in the
  // sidebar/account view even when the form was opened from the account
  // base. Type-specific create branches thread this onto the returned
  // ResourceInstance via `parentResourceId: effectiveParentId`.
  const effectiveParentId =
    parentResourceId ?? (parentExternalId ? `${accountId}:project:${parentExternalId}` : "");

  // DigitalOcean projects are an organizational concept. Resources can be
  // created without being assigned to a project (they land in the default
  // project). When `parentResourceId` points to a project, we assign the
  // newly-created resource to that project via a separate POST after create.
  const assignToProjectIfNeeded = async (urn: string): Promise<void> => {
    if (!parentExternalId) return;
    try {
      await ctx.fetch(`/projects/${parentExternalId}/resources`, {
        method: "POST",
        body: JSON.stringify({ resources: [urn] }),
      });
    } catch (err) {
      warnings.push({
        code: "do.project-assignment-failed",
        message: `Failed to assign ${urn} to project ${parentExternalId}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  };

  const args: DoCreateArgs = {
    ctx,
    typeId,
    accountId,
    fields,
    parentResourceId,
    warnings,
    credentialUpdatesRef,
    parentExternalId,
    effectiveParentId,
    assignToProjectIfNeeded,
  };

  let resource: ResourceInstance | null = null;
  for (const handler of createHandlers) {
    resource = await handler(args);
    if (resource !== null) break;
  }
  if (resource === null) {
    throw new Error(`DigitalOcean plugin: createResource not supported for type "${typeId}"`);
  }

  return {
    resource,
    warnings,
    ...(credentialUpdatesRef.value ? { credentialUpdates: credentialUpdatesRef.value } : {}),
  };
}
