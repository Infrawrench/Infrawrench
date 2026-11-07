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
export const MAX_PAGES = 20;

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
      new Error(`Fireworks API error ${status} for ${url.slice(HOST.length)}: ${body}`),
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
        continueOnEmptyPage: true,
      },
    ),
    /** The audit log's filter goes form-encoded, so a space in it is `+`. */
    auditApi: createApiClient<paths>(shared),
    /** `GET /billingUsage` takes its timestamps with the colons as written. */
    usageApi: createApiClient<paths>({ ...shared, encodeQuery: (value) => value }),
  };
}
