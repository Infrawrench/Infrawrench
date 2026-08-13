import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { Api, NeonFunction, ProjectListItem } from "@neondatabase/api-client";
import {
  enumerateBranches,
  hasStringFields,
  isServiceUnavailable,
  resourceId,
  validatedArray,
  type BranchRef,
} from "./common.js";

/**
 * `@neondatabase/api-client@2.7.3` mistypes the function listing as the
 * single-function `{ function }` response. The published OpenAPI spec documents
 * it as `NeonFunctionsListResponse & CursorPaginationResponse`, so we have to
 * look past the generated type — but we validate at runtime rather than assert,
 * so a drifting SDK or API drops the offending entry instead of throwing a
 * `TypeError` inside `buildFunctionResource`. Revisit when the codegen is fixed.
 */
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

export async function listAllFunctions(
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
): Promise<ResourceInstance[]> {
  const branches = await enumerateBranches(api, projects);
  const results: ResourceInstance[] = [];

  for (const ref of branches) {
    try {
      const resp = await api.listProjectBranchFunctions({
        projectId: ref.projectId,
        branchId: ref.branchId,
      });
      for (const fn of validatedArray(resp.data, "functions", isNeonFunction)) {
        results.push(buildFunctionResource(accountId, ref, fn));
      }
    } catch (err) {
      // Functions are Private Beta: a branch without the entitlement 404s.
      if (!isServiceUnavailable(err)) throw err;
    }
  }
  return results;
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
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
): Promise<ResourceInstance[]> {
  const branches = await enumerateBranches(api, projects);
  const results: ResourceInstance[] = [];

  for (const ref of branches) {
    try {
      const resp = await api.getProjectBranchAiGateway(ref.projectId, ref.branchId);
      if (!resp.data.enabled) continue;
      results.push(buildAiGatewayResource(accountId, ref, resp.data.base_url));
    } catch (err) {
      if (!isServiceUnavailable(err)) throw err;
    }
  }
  return results;
}
