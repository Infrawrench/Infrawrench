/**
 * IaC reconciliation: `/api/org/:orgId/iac`, the handlers.
 *
 * The uploaded document is parsed and thrown away: only the redacted,
 * truncated attribute projection is stored, and the audit rows carry counts,
 * never attribute values. The responses are what the VS Code and Raycast
 * extensions read, sent exactly as the store returns them.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { IAC_STATE_LIMITS } from "@infrawrench/client-core";
import {
  IacInputError,
  deleteIacState,
  listIacStates,
  saveIacState,
} from "@infrawrench/server-core/iac/store";
import {
  buildIacImportPlan,
  getIacResourceStatus,
  runIacReconciliation,
} from "@infrawrench/server-core/iac/service";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { storeCall, type StoreCallOptions } from "../store-errors";
import {
  IacApi,
  IacImportPlan,
  IacReconciliation,
  IacResourceStatus,
  IacStateCreated,
  IacStateList,
} from "./api";

const store: StoreCallOptions<IacInputError> = {
  isInputError: (error): error is IacInputError => error instanceof IacInputError,
  logPrefix: "[iac]",
  failure: "IaC reconciliation failed",
};

const IacHandlers = HttpApiBuilder.group(IacApi, "iac", (handlers) =>
  handlers
    .handle("listStates", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const states = yield* legacy(() => listIacStates(organizationId));
        return yield* respond(IacStateList)({ states });
      }),
    )
    .handle("uploadState", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // Checked here as well as in the parser so an oversized document is
        // refused before anything tries to walk it.
        if (payload.document.length > IAC_STATE_LIMITS.maxDocumentBytes) {
          return yield* badRequest(
            `State document is larger than the ${IAC_STATE_LIMITS.maxDocumentBytes / (1024 * 1024)} MiB limit.`,
          );
        }
        const { state, parsed: document } = yield* storeCall(store, () =>
          saveIacState({
            organizationId,
            label: payload.label,
            accountId: payload.accountId ?? null,
            document: payload.document,
            userId: session.userId,
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "iac_state.upload",
            entityType: "iac_state",
            entityId: state.id,
            // Deliberately no attribute values: the audit log must not become
            // the place a redacted secret reappears.
            metadata: {
              label: state.label,
              format: document.format,
              resourceCount: state.resourceCount,
              redactedAttributeCount: state.redactedAttributeCount,
            },
          }),
        );
        return yield* respond(IacStateCreated, { status: 201 })({ state });
      }),
    )
    .handle("deleteState", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* storeCall(store, () =>
          deleteIacState(organizationId, params.stateId),
        );
        if (!removed) return yield* notFound("Unknown state document");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "iac_state.delete",
            entityType: "iac_state",
            entityId: params.stateId,
          }),
        );
      }),
    )
    .handle("reconciliation", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const stateId = query.stateId;
        if (!stateId) return yield* badRequest("Missing stateId");
        const result = yield* storeCall(store, () =>
          runIacReconciliation({ organizationId, stateId }),
        );
        return yield* respond(IacReconciliation)(result);
      }),
    )
    .handle("importPlan", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const plan = yield* storeCall(store, () =>
          buildIacImportPlan(organizationId, payload.resourceIds),
        );
        return yield* respond(IacImportPlan)(plan);
      }),
    )
    .handle("resource", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const resourceId = query.resourceId;
        if (!resourceId) return yield* badRequest("Missing resourceId");
        const status = yield* storeCall(store, () =>
          getIacResourceStatus(organizationId, resourceId),
        );
        return yield* respond(IacResourceStatus)(status);
      }),
    ),
);

export const iacDomain = makeDomain("iac", IacApi, IacHandlers);
