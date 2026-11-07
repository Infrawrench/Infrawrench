import {
  createApiClient,
  type ApiClient,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

// The document names no operations, so its shapes are looked up by path. Every
// operation is a POST except `pollUpload`, including the ones that only read.

export type UtAppInfo = ApiResponse<paths["/v7/getAppInfo"]["post"]>;
export type UtFile = ApiListItem<paths["/v6/listFiles"]["post"], "files">;

export type UploadThingApi = ApiClient<paths>;

/** Auth is the `x-uploadthing-api-key` header, not a bearer token. */
export function createUploadThingApi(options: {
  apiKey: string;
  caCert?: string | undefined;
  http?: HttpHostServices | undefined;
}): UploadThingApi {
  return createApiClient<paths>({
    vendor: "UploadThing",
    baseUrl: "https://api.uploadthing.com",
    headers: { "x-uploadthing-api-key": options.apiKey },
    // Independent of each other. Coupling `http` to `caCert` means an account with
    // a bastion attached but no custom CA (the normal case) silently falls through
    // to bare `fetch` and skips bastion routing, despite `uploadthing` being in the
    // egress allowlist.
    http: options.http,
    caCert: options.caCert,
  });
}
