import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { Api, NeonFunction } from "@neondatabase/api-client";
import type { ListRun } from "./list-run.js";
import { ListTruncatedError } from "@infrawrench/plugin-base";
import {
  hasStringFields,
  MAX_CHILD_PAGES,
  requireValidRows,
  resourceId,
  type BranchRef,
} from "./common.js";

/** The document's maximum per page. */
const FUNCTION_PAGE_SIZE = 1000;

/** The fields the document requires of a function. */
const FUNCTION_REQUIRED_FIELDS = ["id", "slug", "name", "invocation_url", "created_at"] as const;

function isNeonFunction(value: unknown): value is NeonFunction {
  return hasStringFields(value, FUNCTION_REQUIRED_FIELDS);
}

function buildFunctionResource(
  accountId: string,
  ref: BranchRef,
  fn: NeonFunction,
): ResourceInstance {
  const externalId = `${ref.projectId}/${ref.branchId}/${fn.slug}`;
  // `current_deployment` is the newest build regardless of outcome, which is what
  // the user needs to see; `active_deployment` is the one actually serving.
  const deployment = fn.current_deployment ?? fn.active_deployment;

  return {
    id: resourceId(accountId, "neon-function", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-function",
    accountId,
    displayName: fn.name || fn.slug,
    fields: {
      name: fn.name,
      slug: fn.slug,
      projectId: ref.projectId,
      branchId: ref.branchId,
      invocationUrl: fn.invocation_url,
      deploymentStatus: deployment?.status ?? "",
      runtime: deployment?.runtime ?? "",
      createdAt: fn.created_at,
    },
    resolvedOutputs: { invocationUrl: fn.invocation_url, functionId: fn.id },
    secretStates: [],
    externalId,
    parentResourceId: resourceId(accountId, "neon-branch", `${ref.projectId}/${ref.branchId}`),
    createdAt: fn.created_at,
    updatedAt: fn.created_at,
  };
}

async function listFunctionsOfBranch(api: Api<unknown>, ref: BranchRef): Promise<NeonFunction[]> {
  const path = `/projects/${ref.projectId}/branches/${ref.branchId}/functions`;
  const results: NeonFunction[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHILD_PAGES; page++) {
    const resp = await api.listProjectBranchFunctions({
      projectId: ref.projectId,
      branchId: ref.branchId,
      limit: FUNCTION_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const rows = requireValidRows(resp.data.functions, isNeonFunction, {
      vendor: "Neon",
      path,
      key: "functions",
    });
    results.push(...rows);
    const next = resp.data.pagination?.next;
    if (!next || rows.length === 0) return results;
    cursor = next;
  }
  throw new ListTruncatedError({
    vendor: "Neon",
    path,
    items: results.length,
    maxPages: MAX_CHILD_PAGES,
  });
}

export async function listAllFunctions(
  run: ListRun,
  accountId: string,
): Promise<ResourceInstance[]> {
  return run.readBranchServices(accountId, async (ref) => {
    const functions = await listFunctionsOfBranch(run.api, ref);
    return functions.map((fn) => buildFunctionResource(accountId, ref, fn));
  });
}

function buildAiGatewayResource(
  accountId: string,
  ref: BranchRef,
  baseUrl: string,
): ResourceInstance {
  const externalId = `${ref.projectId}/${ref.branchId}`;
  return {
    id: resourceId(accountId, "neon-ai-gateway", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-ai-gateway",
    accountId,
    displayName: "AI Gateway",
    fields: {
      baseUrl,
      projectId: ref.projectId,
      branchId: ref.branchId,
    },
    resolvedOutputs: { baseUrl },
    secretStates: [],
    externalId,
    parentResourceId: resourceId(accountId, "neon-branch", externalId),
    createdAt: "",
    updatedAt: "",
  };
}

export async function listAllAiGateways(
  run: ListRun,
  accountId: string,
): Promise<ResourceInstance[]> {
  return run.readBranchServices(accountId, async (ref) => {
    const resp = await run.api.getProjectBranchAiGateway(ref.projectId, ref.branchId);
    return resp.data.enabled ? [buildAiGatewayResource(accountId, ref, resp.data.base_url)] : [];
  });
}
