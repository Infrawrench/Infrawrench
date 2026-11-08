/**
 * Scheduled cost exports, the handlers. Transport only: validation of the
 * destination, credential handling and the run itself live in
 * `server-core/src/cost-exports/*`, so the poller drives exactly the same
 * code. Every response is built by the store's `toCostExportView`, which has
 * no branch that emits a credential.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { CostExportInput } from "@infrawrench/client-core";
import {
  CostExportInputError,
  createCostExport,
  deleteCostExport,
  getCostExport,
  getCostExportRow,
  listCostExports,
  updateCostExport,
} from "@infrawrench/server-core/cost-exports/store";
import { runCostExport } from "@infrawrench/server-core/cost-exports/run";
import {
  describeWarehouseSetup,
  listWarehouseOptions,
  listWarehouseSinks,
} from "@infrawrench/server-core/cost-exports/warehouse";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, NotFound, notFound } from "../../errors";
import { decodeAsPayload, readJson } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  CostExport,
  CostExportInputBody,
  CostExportRunResult,
  CostExportsApi,
  WarehouseOptions,
  WarehouseSetup,
  WarehouseSinks,
} from "./api";

/** A store-level validation failure, with the status the client branches on. */
const inputFailure = (error: unknown): BadRequest | NotFound | undefined => {
  if (!(error instanceof CostExportInputError)) return undefined;
  return error.status === 404
    ? new NotFound({ error: error.message })
    : new BadRequest({ error: error.message });
};

/**
 * A warehouse helper's failure: a `WarehouseDestinationError` or the
 * provider's own refusal. Both are things the user can act on, and the form
 * falls back to typing, so every failure is a 400 carrying its message.
 */
const warehouseRefusal = (error: unknown) =>
  new BadRequest({ error: error instanceof Error ? error.message : String(error) });

/** Non-secret one-liner for the audit log: bucket, URL hint, or table. */
function destinationSummary(d: CostExportInput["destination"]): string {
  if (d.kind === "s3") return `${d.bucket}/${d.prefix}`;
  if (d.kind === "http") return d.urlHint;
  return `${d.pluginId}:${Object.values(d.target).join(".")}`;
}

/** The body as the route's validator read it; a body that is not JSON is still a 500. */
const readInput = (request: Parameters<typeof readJson>[0]) =>
  Effect.gen(function* () {
    const input: CostExportInput = yield* decodeAsPayload(
      CostExportInputBody,
      yield* readJson(request),
    );
    return input;
  });

const CostExportsHandlers = HttpApiBuilder.group(CostExportsApi, "costExports", (handlers) =>
  handlers
    // Every export, redacted.
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const exports = yield* legacy(() => listCostExports(organizationId));
        return yield* respond(Schema.Array(CostExport))(exports);
      }),
    )
    // The destination types a connected account can provide (Snowflake,
    // Databricks), with the org's accounts of each and the fields to pick.
    .handle("warehouseSinks", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const sinks = yield* legacy(() => listWarehouseSinks(organizationId));
        return yield* respond(WarehouseSinks)({ sinks });
      }),
    )
    // Picker options for one target field, read live from the provider.
    .handle("warehouseOptions", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const options = yield* legacyTry(
          () =>
            listWarehouseOptions(organizationId, payload.accountId, payload.field, {
              ...payload.target,
            }),
          warehouseRefusal,
        );
        return yield* respond(WarehouseOptions)({ options });
      }),
    )
    // The least-privilege GRANT statements for a target.
    .handle("warehouseSetup", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const setup = yield* legacyTry(
          () => describeWarehouseSetup(organizationId, payload.accountId, { ...payload.target }),
          warehouseRefusal,
        );
        return yield* respond(WarehouseSetup)(setup);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const found = yield* legacy(() => getCostExport(organizationId, params.id));
        if (!found) return yield* notFound();
        return yield* respond(CostExport)(found);
      }),
    )
    // Create. Credentials are required here (the store says so).
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* readInput(request);
        const created = yield* legacyTry(
          () => createCostExport(organizationId, input, session.userId ?? null),
          inputFailure,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_export.create",
            entityType: "cost_export",
            entityId: created.id,
            // Destination and schedule, never the credential: the audit log is
            // readable by every holder of `audit:read`.
            metadata: {
              name: created.name,
              format: created.format,
              schema: created.schema,
              cadence: created.cadence,
              destinationKind: created.destination.kind,
              destination: destinationSummary(created.destination),
            },
          }),
        );
        return yield* respond(CostExport)(created);
      }),
    )
    // Replace everything but the credential.
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* readInput(request);
        const updated = yield* legacyTry(
          () => updateCostExport(organizationId, params.id, input),
          inputFailure,
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_export.update",
            entityType: "cost_export",
            entityId: params.id,
            metadata: {
              name: updated.name,
              schema: updated.schema,
              cadence: updated.cadence,
              enabled: updated.enabled,
              destinationKind: updated.destination.kind,
              credentialChanged: input.accessKeyId !== undefined || input.url !== undefined,
            },
          }),
        );
        return yield* respond(CostExport)(updated);
      }),
    )
    // Soft delete; objects already written stay.
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteCostExport(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_export.delete",
            entityType: "cost_export",
            entityId: params.id,
            metadata: {},
          }),
        );
        return ok;
      }),
    )
    // Run it now: a write, since it pushes org spend to an external
    // destination. Answers 200 with the run's own `status` even when it
    // failed; the same failure is recorded on the row.
    .handle("run", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const row = yield* legacy(() => getCostExportRow(organizationId, params.id));
        if (!row) return yield* notFound();
        const result = yield* legacy(() => runCostExport(row));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_export.run",
            entityType: "cost_export",
            entityId: params.id,
            metadata: {
              status: result.status,
              objectCount: result.objects.length,
              rowCount: result.rowCount,
              ...(result.error ? { error: result.error } : {}),
            },
          }),
        );
        return yield* respond(CostExportRunResult)(result);
      }),
    ),
);

export const costExportsDomain = makeDomain("cost-exports", CostExportsApi, CostExportsHandlers);
