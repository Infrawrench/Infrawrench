import type { LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";
import type {
  LogStreamSelector,
  LogWorkspaceQuery,
  LogWorkspaceQueryCreate,
  LogWorkspaceQueryListResponse,
  LogWorkspaceQueryPatch,
} from "@infrawrench/client-core";
import type { LogResourceOption, LogWorkspaceClient } from "@infrawrench/ui";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/**
 * Web implementation of the log workspace client: stream fetches ride the
 * existing per-resource logs route; saved queries and log-capable discovery
 * use the /log-workspaces routes.
 */
export function createWebLogWorkspaceClient(orgId: string): LogWorkspaceClient {
  return {
    async listLogResources(): Promise<LogResourceOption[]> {
      const res = await apiGet<{ resources: LogResourceOption[] }>(
        `/api/org/${orgId}/log-workspaces/resources`,
      );
      return res.resources;
    },
    fetchLogs(selector: LogStreamSelector, params: LogsFetchParams): Promise<LogsFetchResult> {
      return apiPost<LogsFetchResult>(
        `/api/org/${orgId}/resources/${selector.pluginId}/${selector.resourceTypeId}/logs`,
        {
          accountId: selector.accountId,
          resourceId: selector.resourceId,
          ...params,
        },
      );
    },
    savedQueries: {
      async list(): Promise<LogWorkspaceQuery[]> {
        const res = await apiGet<LogWorkspaceQueryListResponse>(`/api/org/${orgId}/log-workspaces`);
        return res.queries;
      },
      create(input: LogWorkspaceQueryCreate): Promise<LogWorkspaceQuery> {
        return apiPost<LogWorkspaceQuery>(`/api/org/${orgId}/log-workspaces`, input);
      },
      update(queryId: string, patch: LogWorkspaceQueryPatch): Promise<LogWorkspaceQuery> {
        return apiPut<LogWorkspaceQuery>(
          `/api/org/${orgId}/log-workspaces/${encodeURIComponent(queryId)}`,
          patch,
        );
      },
      async remove(queryId: string): Promise<void> {
        await apiDelete(`/api/org/${orgId}/log-workspaces/${encodeURIComponent(queryId)}`);
      },
    },
  };
}
