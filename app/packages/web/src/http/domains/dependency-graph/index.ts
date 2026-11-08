/**
 * Dependency graph: `/api/org/:orgId/dependency-graph`, the handlers.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { DependencyGraphApi, DependencyGraphResponse } from "@infrawrench/api-contract";
import { loadDependencyGraph } from "../../../services/dependency-graph";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const DependencyGraphHandlers = HttpApiBuilder.group(
  DependencyGraphApi,
  "dependencyGraph",
  (handlers) =>
    handlers.handle("get", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const focusId = query.resourceId?.trim() || null;
        const graph = yield* legacy(() => loadDependencyGraph(organizationId, focusId));
        return yield* respond(DependencyGraphResponse)(graph);
      }),
    ),
);

export const dependencyGraphDomain = makeDomain(
  "dependency-graph",
  DependencyGraphApi,
  DependencyGraphHandlers,
);
