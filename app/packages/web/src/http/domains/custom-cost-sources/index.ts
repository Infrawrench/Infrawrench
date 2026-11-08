/**
 * Custom cost sources: `/api/org/:orgId/custom-cost-sources`, the handlers.
 * See `server-core/src/cost/custom-costs.ts` for the model; these handlers
 * are transport only, run through `legacy` inside the request's scopes.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  appendCustomCostRows,
  completeCustomCostUpload,
  CostIngestError,
  createCustomCostSource,
  createCustomCostUpload,
  CustomCostError,
  CustomCostOverlapError,
  deleteCustomCostSource,
  deleteCustomCostUpload,
  getCustomCostSource,
  listCustomCostSources,
  listCustomCostUploads,
  updateCustomCostSource,
} from "@infrawrench/server-core/cost/custom-costs";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, HttpFailure, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  CustomCostRowsWritten,
  CustomCostSource,
  CustomCostSourcesApi,
  CustomCostUpload,
} from "./api";

/** The service's caller-fixable errors, as 400s with its own message. */
const customCostCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, (error) =>
    error instanceof CustomCostError || error instanceof CostIngestError
      ? new BadRequest({ error: error.message })
      : undefined,
  );

const CustomCostSourcesHandlers = HttpApiBuilder.group(
  CustomCostSourcesApi,
  "customCostSources",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const sources = yield* legacy(() => listCustomCostSources(organizationId));
          return yield* respond(Schema.Array(CustomCostSource))(sources);
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const source = yield* customCostCall(() =>
            createCustomCostSource(organizationId, payload, session.userId),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "custom_cost_source.create",
              entityType: "custom_cost_source",
              entityId: source.id,
              metadata: { name: source.name },
            }),
          );
          return yield* respond(CustomCostSource)(source);
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const source = yield* legacy(() => getCustomCostSource(organizationId, params.id));
          if (!source) return yield* notFound();
          return yield* respond(CustomCostSource)(source);
        }),
      )
      // Rename, redescribe, change the default currency.
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const source = yield* customCostCall(() =>
            updateCustomCostSource(organizationId, params.id, payload),
          );
          if (!source) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "custom_cost_source.update",
              entityType: "custom_cost_source",
              entityId: source.id,
              metadata: { name: source.name },
            }),
          );
          return yield* respond(CustomCostSource)(source);
        }),
      )
      // Delete a source and all of its spend.
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* legacy(() => deleteCustomCostSource(organizationId, params.id));
          if (!result.deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "custom_cost_source.delete",
              entityType: "custom_cost_source",
              entityId: params.id,
              metadata: { zeroedRows: result.zeroedRows },
            }),
          );
          return { ok: true, zeroedRows: result.zeroedRows } as const;
        }),
      )
      // Upload history, newest first.
      .handle("listUploads", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const source = yield* legacy(() => getCustomCostSource(organizationId, params.id));
          if (!source) return yield* notFound();
          const uploads = yield* legacy(() => listCustomCostUploads(organizationId, params.id));
          return yield* respond(Schema.Array(CustomCostUpload))(uploads);
        }),
      )
      /**
       * Open an upload. 409 with `overlapping` when the range overlaps
       * earlier uploads and no `mode` was given; the uploads ride the body
       * exactly as the service listed them.
       */
      .handle("createUpload", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const upload = yield* customCostCall(async () => {
            try {
              return await createCustomCostUpload(
                organizationId,
                params.id,
                payload,
                session.userId,
              );
            } catch (error) {
              if (error instanceof CustomCostOverlapError) {
                throw new HttpFailure(409, {
                  error: error.message,
                  code: "overlap",
                  overlapping: error.overlapping,
                });
              }
              throw error;
            }
          });
          if (!upload) return yield* notFound();
          return yield* respond(CustomCostUpload)(upload);
        }),
      )
      // Append a chunk; the ingest module validates every row.
      .handle("appendRows", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* customCostCall(() =>
            appendCustomCostRows(organizationId, params.id, params.uploadId, payload.rows),
          );
          if (!result) return yield* notFound();
          return yield* respond(CustomCostRowsWritten)(result);
        }),
      )
      // Finish, applying `replace`.
      .handle("completeUpload", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* customCostCall(() =>
            completeCustomCostUpload(organizationId, params.id, params.uploadId),
          );
          if (!result) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "custom_cost_upload.complete",
              entityType: "custom_cost_source",
              entityId: params.id,
              metadata: {
                uploadId: result.upload.id,
                fileName: result.upload.fileName,
                rows: result.upload.rowCount,
                mode: result.upload.mode,
                replacedRows: result.replacedRows,
              },
            }),
          );
          return yield* respond(CustomCostUpload)(result.upload);
        }),
      )
      // Delete an upload and the rows it wrote.
      .handle("deleteUpload", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* legacy(() =>
            deleteCustomCostUpload(organizationId, params.id, params.uploadId),
          );
          if (!result.deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "custom_cost_upload.delete",
              entityType: "custom_cost_source",
              entityId: params.id,
              metadata: { uploadId: params.uploadId, zeroedRows: result.zeroedRows },
            }),
          );
          return { ok: true, zeroedRows: result.zeroedRows } as const;
        }),
      ),
);

export const customCostSourcesDomain = makeDomain(
  "custom-cost-sources",
  CustomCostSourcesApi,
  CustomCostSourcesHandlers,
);
