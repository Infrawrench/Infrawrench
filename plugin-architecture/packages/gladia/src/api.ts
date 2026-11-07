import {
  createApiClient,
  jsonRestFetch,
  restRequest,
  type ApiBody,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

/**
 * The Gladia Control API, typed from Gladia's published OpenAPI document.
 *
 * Auth is `x-gladia-key: <key>`: Gladia does not use Bearer.
 *
 * Pre-recorded and live jobs share one response shape (`kind` tells them apart)
 * but live under different paths and differ in `request_params`.
 */
export const BASE_URL = "https://api.gladia.io";

export const VENDOR = "Gladia";

type Schemas = components["schemas"];

/** A pre-recorded or live job. Failures are HTTP 200 with `status: "error"`. */
export type GladiaJob = Schemas["PreRecordedResponse"] | Schemas["StreamingResponse"];

/** What this plugin reads of `request_params`, across both kinds of job. */
export type GladiaJobParams = Pick<
  Schemas["StreamingRequestParamsResponse"],
  "encoding" | "sample_rate" | "bit_depth" | "channels"
> & { model?: string };

export type InitTranscriptionBody = ApiBody<
  operations["PreRecordedController_initPreRecordedJob_v2"]
>;

type UploadResponse = ApiResponse<operations["FileController_upload_v2"]>;

export type GladiaApi = ApiClient<paths>;

/** Everything a request needs. */
export interface GladiaConnection {
  apiKey: string;
  /** Empty when the account has none. */
  caCert: string;
  http: HttpHostServices | undefined;
}

function gladiaHeaders(apiKey: string): Record<string, string> {
  return { "x-gladia-key": apiKey, Accept: "application/json" };
}

export function createGladiaApi({ apiKey, caCert, http }: GladiaConnection): GladiaApi {
  return createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: BASE_URL,
    headers: gladiaHeaders(apiKey),
    http,
    caCert,
  });
}

/** `POST /v2/upload` is multipart, which the typed client cannot write. */
export function postAudioUpload(
  { apiKey, caCert, http }: GladiaConnection,
  multipart: { body: Uint8Array<ArrayBuffer>; contentType: string },
): Promise<UploadResponse> {
  const path = "/v2/upload";
  return jsonRestFetch<UploadResponse>({
    vendor: VENDOR,
    url: `${BASE_URL}${path}`,
    errorPath: path,
    headers: gladiaHeaders(apiKey),
    init: {
      method: "POST",
      headers: { "Content-Type": multipart.contentType },
      // `buildMultipartBody` returns an `ArrayBuffer`-backed view, which `BodyInit`
      // admits; `bodyForHostHttp` has an explicit `instanceof Uint8Array` branch,
      // which is exactly the path that keeps this upload on the host's
      // bastion-routed HTTP service.
      body: multipart.body,
    },
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  });
}

/**
 * `DELETE /v2/pre-recorded/{id}` and `DELETE /v2/live/{id}` answer 202 Accepted
 * with no body. Whatever does come back on a 2xx is ignored, so it stays out of
 * the typed client, which would parse it. `Content-Type` goes only with a body.
 */
export async function deleteJobRequest(
  { apiKey, caCert, http }: GladiaConnection,
  path: string,
): Promise<void> {
  await restRequest<string>({
    vendor: VENDOR,
    url: `${BASE_URL}${path}`,
    errorPath: path,
    headers: gladiaHeaders(apiKey),
    init: { method: "DELETE" },
    contentType: "with-body",
    responseAs: "text",
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  });
}
