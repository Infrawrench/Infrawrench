/**
 * Cost push: `POST /api/org/:orgId/costs/rows`, the handler.
 *
 * Authenticates before the body is read, as the Hono route did: a session, a
 * WorkOS bearer token or an `iwk_` key holding `costs:write`, pinned to the
 * path's org. Then the envelope, then the shared ingest module, whose
 * `CostIngestError` is the caller's fault (a 400 with its sentence) and
 * anything else ours.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  CostIngestError,
  writeExternalCostRows,
} from "@infrawrench/server-core/cost/external-costs";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest } from "../../errors";
import { decodeAsPayload, readJsonOr } from "../../json-body";
import { fireAndForget, legacyTry } from "../../legacy";
import { asOrgRequestCaller } from "../../org-request-caller";
import { respond } from "../../response";
import { CostIngestApi, CostPushRequest, CostPushResponse } from "./api";

const CostIngestHandlers = HttpApiBuilder.group(CostIngestApi, "costIngest", (handlers) =>
  handlers.handleRaw("push", ({ request, params }) =>
    asOrgRequestCaller("costs:write", (auth) =>
      Effect.gen(function* () {
        // A body that is not JSON reaches the envelope check as null, as before.
        const body = yield* readJsonOr(request, null);
        const { source, rows } = yield* decodeAsPayload(CostPushRequest, body);
        const result = yield* legacyTry(
          () => writeExternalCostRows({ organizationId: params.orgId, source, rows }),
          // Everything the caller can fix is a CostIngestError; anything else is ours.
          (error) =>
            error instanceof CostIngestError ? new BadRequest({ error: error.message }) : undefined,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId: params.orgId,
            userId: auth.userId,
            apiKeyId: auth.apiKeyId,
            action: "costs.push",
            entityType: "costs",
            entityId: source,
            metadata: { rows: result.written },
          }),
        );
        return yield* respond(CostPushResponse)(result);
      }),
    ),
  ),
);

export const costIngestDomain = makeDomain("costIngest", CostIngestApi, CostIngestHandlers);
