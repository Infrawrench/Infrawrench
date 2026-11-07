import {
  createApiClient,
  pathEncode,
  withCursorPagination,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

export const HOST = "https://api.fireworks.ai";

/** `pageSize` is clamped server-side at 200; anything larger is silently coerced. */
export const PAGE_SIZE = 200;
/** 50,000 rows, the most the host can prune against. */
export const MAX_PAGES = 250;
/** A create form can offer part of a long list. */
export const PICKER_MAX_PAGES = 20;

/** Carries the status, because a path or a response body can hold any digits. */
export class FireworksApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FireworksApiError";
    this.status = status;
  }
}

export function hasStatus(error: unknown, ...statuses: number[]): boolean {
  return error instanceof FireworksApiError && statuses.includes(error.status);
}

/** An operation's response, by its `operationId`. */
export type FireworksResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type Deployment = FireworksResponse<"Gateway_GetDeployment">;
export type Model = FireworksResponse<"Gateway_GetModel">;
export type Dataset = FireworksResponse<"Gateway_GetDataset">;
export type DeployedModel = FireworksResponse<"Gateway_GetDeployedModel">;
export type BatchInferenceJob = FireworksResponse<"Gateway_GetBatchInferenceJob">;
export type SupervisedFineTuningJob = FireworksResponse<"Gateway_GetSupervisedFineTuningJob">;
export type DpoJob = FireworksResponse<"Gateway_GetDpoJob">;
export type ReinforcementFineTuningJob = FireworksResponse<"Gateway_GetReinforcementFineTuningJob">;
export type Evaluator = FireworksResponse<"Gateway_GetEvaluator">;
export type EvaluationJob = FireworksResponse<"Gateway_GetEvaluationJob">;
export type Router = FireworksResponse<"Gateway_GetRouter">;
export type User = FireworksResponse<"Gateway_GetUser">;
export type Secret = FireworksResponse<"Gateway_GetSecret">;
export type Quota = FireworksResponse<"Gateway_GetQuota">;
export type ApiKey = ApiListItem<operations["Gateway_ListApiKeys"], "apiKeys">;
export type AuditLogEntry = ApiListItem<operations["Gateway_ListAuditLogs"], "auditLogs">;
/** google.type.Money, as a fine-tuning job estimates its cost. */
export type Money = NonNullable<SupervisedFineTuningJob["estimatedCost"]>;

export function createFireworksApi(options: {
  apiKey: string;
  accountId: string;
  caCert: string;
  http: HttpHostServices | undefined;
}) {
  const { apiKey, accountId, caCert, http } = options;
  const shared = {
    vendor: "Fireworks",
    baseUrl: `${HOST}/v1/accounts/${pathEncode(accountId)}`,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    // Errors have always named the whole path, account included.
    httpError: ({ status, url, body }: { status: number; url: string; body: string }) =>
      new FireworksApiError(
        status,
        `Fireworks API error ${status} for ${url.slice(HOST.length)}: ${body}`,
      ),
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  };
  return {
    /** Every control-plane list answers `{<plural>: [], nextPageToken, totalSize}`. */
    api: withCursorPagination(
      createApiClient<paths>({ ...shared, encodeQuery: encodeURIComponent }),
      {
        cursorParam: "pageToken",
        sizeParam: "pageSize",
        pageSize: PAGE_SIZE,
        maxPages: MAX_PAGES,
        next: "nextPageToken",
        // The document: "If this field is omitted, there are no subsequent pages."
        // So the token ends a list, not an empty page.
        continueOnEmptyPage: true,
        // The document is generated from protobuf (`protobufAny`, int64 as a string),
        // and proto3 JSON leaves an empty repeated field out of the answer.
        missingListIsEmpty: true,
      },
    ),
    /** The audit log's filter goes form-encoded, so a space in it is `+`. */
    auditApi: createApiClient<paths>(shared),
    /** `GET /billingUsage` takes its timestamps with the colons as written. */
    usageApi: createApiClient<paths>({ ...shared, encodeQuery: (value) => value }),
  };
}
