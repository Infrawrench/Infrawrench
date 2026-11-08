/**
 * Cost-report folders: `/api/org/:orgId/cost-report-folders`, the handlers.
 *
 * The tree rules (nesting depth, no reparenting under a descendant) are
 * enforced in services/cost-report-folders.ts and surface as
 * `CostReportFolderError`, a 400 with its sentence. Object sharing refusals
 * thrown by the services render as they always did (see `renderDefect`).
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  BadRequest,
  CostReportFolder,
  CostReportFoldersApi,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  CostReportFolderError,
  createCostReportFolder,
  deleteCostReportFolder,
  listVisibleCostReportFolders,
  updateCostReportFolder,
} from "../../../services/cost-report-folders";
import { grantCreatorOwnership } from "../../../services/object-sharing";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** A folder outside the org, past the depth limit or inside its own subtree. */
const treeRefusal = (error: unknown) =>
  error instanceof CostReportFolderError ? new BadRequest({ error: error.message }) : undefined;

const CostReportFoldersHandlers = HttpApiBuilder.group(
  CostReportFoldersApi,
  "costReportFolders",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const folders = yield* legacy(() => listVisibleCostReportFolders(organizationId));
          return yield* respond(Schema.Array(CostReportFolder))(folders);
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* legacyTry(async () => {
            const folder = await createCostReportFolder(organizationId, payload);
            await grantCreatorOwnership(
              organizationId,
              "cost_report_folder",
              folder.id,
              session.userId,
            );
            return folder;
          }, treeRefusal);
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_report_folder.create",
              entityType: "cost_report_folder",
              entityId: created.id,
              metadata: { name: created.name },
            }),
          );
          return yield* respond(CostReportFolder)(created);
        }),
      )
      // The 400s here are the tree rules: a parent past the depth limit, or a
      // parent inside the folder's own subtree (the cycle case).
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const updated = yield* legacyTry(
            () => updateCostReportFolder(organizationId, params.id, payload),
            treeRefusal,
          );
          if (!updated) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_report_folder.update",
              entityType: "cost_report_folder",
              entityId: updated.id,
              metadata: { name: updated.name },
            }),
          );
          return yield* respond(CostReportFolder)(updated);
        }),
      )
      // Never blocked by contents and never destructive to them: the SET NULL
      // foreign keys drop the folder's reports and immediate subfolders to the
      // top level (see deleteCostReportFolder for why over refuse-until-empty).
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const deleted = yield* legacy(() => deleteCostReportFolder(organizationId, params.id));
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_report_folder.delete",
              entityType: "cost_report_folder",
              entityId: params.id,
              metadata: {},
            }),
          );
          return ok;
        }),
      ),
);

export const costReportFoldersDomain = makeDomain(
  "cost-report-folders",
  CostReportFoldersApi,
  CostReportFoldersHandlers,
);
