import {
  COST_CHARGE_TYPES,
  CUSTOM_COST_FORMATS,
  CUSTOM_COST_LIMITS,
  CUSTOM_COST_UPLOAD_MODES,
} from "@infrawrench/client-core";
import { z } from "../zod";
import { strict, ErrorResponse, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const TAG = "Custom Cost Sources";

const CustomCostSourceInput = strict({
  name: z
    .string()
    .min(1)
    .max(CUSTOM_COST_LIMITS.maxNameLength)
    .openapi({
      example: "Colo invoices",
      description:
        "Unique within the organization (case-insensitively). Shown as the provider name in " +
        "every cost report; renaming relabels the source's whole history.",
    }),
  description: z.string().max(CUSTOM_COST_LIMITS.maxDescriptionLength).nullish(),
  defaultCurrency: z
    .string()
    .length(3)
    .nullish()
    .openapi({
      example: "USD",
      description:
        "ISO 4217 code applied to rows whose file has no currency column. Null means every " +
        "file must carry one.",
    }),
}).openapi("CustomCostSourceInput");

const CustomCostSource = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  defaultCurrency: z.string().nullable(),
  pluginId: z.string().openapi({
    example: "custom:0f8e…",
    description:
      "The value this source's rows carry in the cost `provider` dimension. Use it in cost " +
      "filters, budgets, and allocation rules.",
  }),
  uploadCount: z.number().int(),
  lastUploadAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CustomCostSource");

const CustomCostUpload = strict({
  id: Uuid,
  sourceId: Uuid,
  fileName: z.string().nullable(),
  format: z.enum(CUSTOM_COST_FORMATS),
  mode: z.enum(CUSTOM_COST_UPLOAD_MODES),
  status: z.enum(["uploading", "complete", "replaced"]).openapi({
    description:
      "`uploading` until complete is called (an interrupted upload stays here and can be " +
      "deleted); `replaced` once a later replace upload superseded every row it held.",
  }),
  fromDate: IsoDate,
  toDate: IsoDate,
  rowCount: z.number().int().openapi({ description: "Daily rows this upload still holds." }),
  totals: z
    .record(z.string(), z.number())
    .openapi({ description: "Currency code → cash amount this upload still holds." }),
  uploadedBy: strict({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }).nullable(),
  via: z.enum(["web", "desktop", "cli", "api"]),
  createdAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
}).openapi("CustomCostUpload");

const CustomCostUploadCreate = strict({
  fileName: z.string().max(CUSTOM_COST_LIMITS.maxFileNameLength).nullish(),
  format: z.enum(CUSTOM_COST_FORMATS),
  mode: z
    .enum(CUSTOM_COST_UPLOAD_MODES)
    .optional()
    .openapi({
      description:
        "What to do with spend this source already holds in the range. `append` adds to it; " +
        "`replace` zeroes it (from every earlier upload) when this upload completes. Required " +
        "when the range overlaps an earlier upload that still holds rows: omitted, that case is " +
        "a 409 listing the overlapping uploads.",
    }),
  via: z.enum(["web", "desktop", "cli", "api"]).optional(),
  fromDate: IsoDate.openapi({ description: "Inclusive. Rows outside the range are rejected." }),
  toDate: IsoDate,
}).openapi("CustomCostUploadCreate");

const CustomCostRow = strict({
  date: IsoDate,
  currency: z.string().length(3),
  amount: z.number().describe("Cash amount. Negative for credits."),
  service: z.string().max(256).optional(),
  region: z.string().max(256).optional(),
  resourceId: z.string().max(256).optional(),
  subAccount: z
    .string()
    .max(256)
    .optional()
    .describe("The file's own account label; splits the account dimension within the source."),
  tags: z
    .record(z.string())
    .optional()
    .describe("At most 32. Keys starting with `infrawrench:` are reserved and rejected."),
  usageAmount: z.number().optional(),
  usageUnit: z.string().max(256).optional(),
  chargeType: z.enum(COST_CHARGE_TYPES).optional(),
  amortizedAmount: z
    .number()
    .optional()
    .describe("Amortized (effective) cost, e.g. FOCUS EffectiveCost. Omit when unknown."),
  commitmentId: z.string().max(256).optional(),
}).openapi("CustomCostRow", {
  description:
    "One day of spend for one dimension combination. Clients aggregate file lines to this " +
    "grain before sending: two rows with the same date, dimensions, tags and currency in one " +
    "upload replace each other rather than adding.",
});

const CustomCostOverlap = strict({
  error: z.string(),
  code: z.literal("overlap"),
  overlapping: z.array(CustomCostUpload),
}).openapi("CustomCostOverlap");

const DeletedWithRows = strict({
  ok: z.literal(true),
  zeroedRows: z.number().int(),
}).openapi("CustomCostDeleted");

export function registerCustomCostSourcePaths(ctx: BuildContext) {
  const { registry } = ctx;
  const base = "/api/org/{orgId}/custom-cost-sources";
  const idParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });
  const uploadParam = idParam.extend({
    uploadId: Uuid.openapi({ param: { name: "uploadId", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: base,
    tags: [TAG],
    summary: "List custom cost sources",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Sources, name-sorted",
        content: { "application/json": { schema: z.array(CustomCostSource) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: base,
    tags: [TAG],
    summary: "Create a custom cost source",
    description:
      "A named provider for spend Infrawrench has no plugin for. Fill it by uploading files " +
      "(CSV or FOCUS) from Settings, `infrawrench costs push --format csv|focus`, or the upload " +
      "endpoints below.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CustomCostSourceInput } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CustomCostSource } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: `${base}/{id}`,
    tags: [TAG],
    summary: "Get a custom cost source",
    request: { params: idParam },
    responses: {
      200: {
        description: "The source",
        content: { "application/json": { schema: CustomCostSource } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: `${base}/{id}`,
    tags: [TAG],
    summary: "Update a custom cost source",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: CustomCostSourceInput } }, required: true },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: CustomCostSource } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: `${base}/{id}`,
    tags: [TAG],
    summary: "Delete a custom cost source and all of its spend",
    description:
      "Zeroes every cost row the source holds, then deletes it with its upload history. The " +
      "spend disappears from every report, budget and export.",
    request: { params: idParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: DeletedWithRows } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: `${base}/{id}/uploads`,
    tags: [TAG],
    summary: "List a source's uploads",
    request: { params: idParam },
    responses: {
      200: {
        description: "Upload history, newest first",
        content: { "application/json": { schema: z.array(CustomCostUpload) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/{id}/uploads`,
    tags: [TAG],
    summary: "Start an upload",
    description:
      "Declares the upload's date range and what happens to spend already held in it. Then send " +
      "rows with `…/rows` (up to 5,000 per call) and finish with `…/complete`.",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: CustomCostUploadCreate } }, required: true },
    },
    responses: {
      200: { description: "Opened", content: { "application/json": { schema: CustomCostUpload } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "The range overlaps earlier uploads and no `mode` was given",
        content: { "application/json": { schema: CustomCostOverlap } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/{id}/uploads/{uploadId}/rows`,
    tags: [TAG],
    summary: "Send a chunk of rows to an open upload",
    description: "The chunk is validated whole: a 400 means none of it was written.",
    request: {
      params: uploadParam,
      body: {
        content: {
          "application/json": {
            schema: strict({
              rows: z.array(CustomCostRow).max(CUSTOM_COST_LIMITS.maxRowsPerChunk),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Rows written",
        content: { "application/json": { schema: strict({ written: z.number().int() }) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: `${base}/{id}/uploads/{uploadId}/complete`,
    tags: [TAG],
    summary: "Finish an upload",
    description:
      "Applies `replace` (zeroing this source's rows from other uploads in the range) and " +
      "records what the upload holds.",
    request: { params: uploadParam },
    responses: {
      200: {
        description: "Completed",
        content: { "application/json": { schema: CustomCostUpload } },
      },
      400: {
        description: "Already complete",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: `${base}/{id}/uploads/{uploadId}`,
    tags: [TAG],
    summary: "Delete an upload and the rows it wrote",
    request: { params: uploadParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: DeletedWithRows } } },
      404: ErrorResponses[404],
    },
  });
}
