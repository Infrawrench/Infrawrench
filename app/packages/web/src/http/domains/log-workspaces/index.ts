/**
 * Log workspace saved queries: `/api/org/:orgId/log-workspaces`, the
 * handlers. The store owns validation and persistence; these read each body
 * by hand, as the routes did, and shape the wire row with the store's
 * `toWire`.
 */
import { Effect, Predicate } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { LogStreamSelector } from "@infrawrench/client-core";
import {
  LogWorkspaceInputError,
  createLogWorkspaceRecord,
  deleteLogWorkspaceRecord,
  listLogWorkspaceQueries,
  toWire,
  updateLogWorkspaceRecord,
  type LogWorkspaceQueryCreateInput,
  type LogWorkspaceQueryUpdateInput,
} from "@infrawrench/server-core/log-workspaces/store";
import {
  badRequest,
  LogCapableResourceList,
  LogWorkspaceQuery,
  LogWorkspaceQueryConflict,
  LogWorkspaceQueryList,
  LogWorkspaceQueryUpdateConflict,
  LogWorkspacesApi,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { listLogCapableResources } from "../../../services/log-workspaces";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refuse, refusalCall, type RefusalPolicy, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const store: RefusalPolicy = refusalsOf(LogWorkspaceInputError, {
  logPrefix: "[log-workspaces]",
  failure: "Saved query operation failed",
});

const SELECTOR_KEYS = ["resourceId", "accountId", "pluginId", "resourceTypeId"] as const;

function readSelectors(value: unknown): LogStreamSelector[] | { readonly error: string } {
  if (!Array.isArray(value)) return { error: "resources must be an array" };
  const selectors: LogStreamSelector[] = [];
  for (const entry of value) {
    if (!Predicate.isObject(entry) || Array.isArray(entry)) {
      return { error: "each resource must be an object" };
    }
    for (const key of SELECTOR_KEYS) {
      const field = entry[key];
      if (!Predicate.isString(field) || field.length === 0) {
        return { error: `each resource needs a string ${key}` };
      }
    }
    const { resourceId, accountId, pluginId, resourceTypeId, container, parentResourceId } = entry;
    if (container !== undefined && !Predicate.isString(container)) {
      return { error: "container must be a string when present" };
    }
    if (parentResourceId !== undefined && !Predicate.isString(parentResourceId)) {
      return { error: "parentResourceId must be a string when present" };
    }
    // Checked in the loop above; restated so the compiler sees the strings.
    if (
      !Predicate.isString(resourceId) ||
      !Predicate.isString(accountId) ||
      !Predicate.isString(pluginId) ||
      !Predicate.isString(resourceTypeId)
    ) {
      return { error: "each resource must be an object" };
    }
    selectors.push({
      resourceId,
      accountId,
      pluginId,
      resourceTypeId,
      ...(parentResourceId ? { parentResourceId } : {}),
      ...(container ? { container } : {}),
    });
  }
  return selectors;
}

const readBody = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const parsed = yield* readObjectBody(request);
  if (!parsed.ok) return yield* badRequest(parsed.error);
  return parsed.body;
});

const LogWorkspacesHandlers = HttpApiBuilder.group(LogWorkspacesApi, "logWorkspaces", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const queries = yield* legacy(() => listLogWorkspaceQueries(organizationId));
        return yield* respond(LogWorkspaceQueryList)(queries);
      }),
    )
    .handle("resources", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const resources = yield* legacy(() => listLogCapableResources(organizationId));
        return yield* respond(LogCapableResourceList)(resources);
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readBody(request);
        const { name, search, alertEnabled } = body;
        if (!Predicate.isString(name)) return yield* badRequest("name is required");
        if (!Predicate.isString(search)) return yield* badRequest("search must be a string");
        const selectors = readSelectors(body["resources"]);
        if ("error" in selectors) return yield* badRequest(selectors.error);
        if (alertEnabled !== undefined && !Predicate.isBoolean(alertEnabled)) {
          return yield* badRequest("alertEnabled must be a boolean");
        }
        const input: LogWorkspaceQueryCreateInput = {
          name,
          resources: selectors,
          search,
          ...(alertEnabled !== undefined ? { alertEnabled } : {}),
        };
        const created = yield* refusalCall(
          store,
          {
            400: refuse[400],
            404: refuse[404],
            409: (error: string) => new LogWorkspaceQueryConflict({ error }),
          },
          () => createLogWorkspaceRecord(organizationId, input, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "log_workspace_query.create",
            entityType: "log_workspace_query",
            entityId: created.id,
            metadata: {
              name: created.name,
              resourceCount: created.resources.length,
              alertEnabled: created.alertEnabled,
            },
          }),
        );
        return yield* respond(LogWorkspaceQuery, { status: 201 })(toWire(created));
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readBody(request);
        const { name, search, resources, alertEnabled } = body;
        const patch: LogWorkspaceQueryUpdateInput = {};
        if (name !== undefined) {
          if (!Predicate.isString(name)) return yield* badRequest("name must be a string");
          patch.name = name;
        }
        if (search !== undefined) {
          if (!Predicate.isString(search)) return yield* badRequest("search must be a string");
          patch.search = search;
        }
        if (resources !== undefined) {
          const selectors = readSelectors(resources);
          if ("error" in selectors) return yield* badRequest(selectors.error);
          patch.resources = selectors;
        }
        if (alertEnabled !== undefined) {
          if (!Predicate.isBoolean(alertEnabled)) {
            return yield* badRequest("alertEnabled must be a boolean");
          }
          patch.alertEnabled = alertEnabled;
        }
        if (Object.keys(patch).length === 0) return yield* badRequest("No changes supplied");
        const updated = yield* refusalCall(
          store,
          {
            400: refuse[400],
            404: refuse[404],
            409: (error: string) => new LogWorkspaceQueryUpdateConflict({ error }),
          },
          () => updateLogWorkspaceRecord(organizationId, params.queryId, patch),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "log_workspace_query.update",
            entityType: "log_workspace_query",
            entityId: updated.id,
            metadata: { name: updated.name, patch: Object.keys(patch) },
          }),
        );
        return yield* respond(LogWorkspaceQuery)(toWire(updated));
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* refusalCall(store, { 404: refuse[404] }, () =>
          deleteLogWorkspaceRecord(organizationId, params.queryId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "log_workspace_query.delete",
            entityType: "log_workspace_query",
            entityId: deleted.id,
            metadata: { name: deleted.name },
          }),
        );
      }),
    ),
);

export const logWorkspacesDomain = makeDomain(
  "log-workspaces",
  LogWorkspacesApi,
  LogWorkspacesHandlers,
);
