import {
  createApiClient,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

export type { operations };

/** An operation's response, by its `operationId`. */
export type CloudinaryResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type CloudinaryResource = CloudinaryResponse<"getResourceByAssetId">;
export type CloudinaryFolder = ApiListItem<operations["listRootFolders"], "folders">;
export type CloudinaryUploadPreset = ApiListItem<operations["listUploadPresets"], "presets">;
export type CloudinaryTrigger = ApiListItem<operations["listTrigger"], "triggers">;
export type CloudinaryConfig = CloudinaryResponse<"getConfig">;
export type CloudinaryVideoView = ApiListItem<operations["getVideoViews"], "data">;

/** `upload_presets` is not in the document, and neither is an answer that is the array itself. */
export type CloudinaryUploadPresetPage =
  | (CloudinaryResponse<"listUploadPresets"> & { upload_presets?: CloudinaryUploadPreset[] })
  | CloudinaryUploadPreset[];

/** `derived` is only on a single transformation in the document, not on a listed one. */
export type CloudinaryTransformation = ApiListItem<
  operations["listTransformations"],
  "transformations"
> & { derived?: object[] };

/** A mapping as the plugin keeps it: creating one answers no template, which the form supplies. */
export type CloudinaryUploadMapping = Pick<
  ApiListItem<operations["listUploadMappings"], "mappings">,
  "folder"
> & { template?: string; external_id?: string };

/** The document has no rate limit fields on this response. */
export type CloudinaryUsage = CloudinaryResponse<"getUsage"> & {
  rate_limit_allowed?: number;
  rate_limit_remaining?: number;
};

/**
 * Cursors go back as `next_cursor`, only once there is one. `String` because they
 * are not validated: whatever the provider sent goes back as its text, and would
 * otherwise be read as an array or a nested parameter.
 */
export function cursorQuery(cursor: string | null | undefined): { next_cursor?: string } {
  return cursor ? { next_cursor: String(cursor) } : {};
}

export function createCloudinaryApis(options: {
  cloudName: string;
  authorization: () => Promise<string>;
  caCert: string;
  http: HttpHostServices | undefined;
}) {
  const { cloudName, authorization, caCert, http } = options;
  const shared = {
    vendor: "Cloudinary",
    baseUrl: `https://api.cloudinary.com/v1_1/${cloudName}`,
    headers: async () => ({ Authorization: await authorization() }),
    http,
    caCert,
  };
  return {
    api: createApiClient<paths>({ ...shared, encodeQuery: encodeURIComponent }),
    /** Video Analytics takes a search expression, form-encoded (a space is `+`). */
    videoAnalytics: createApiClient<paths>(shared),
  };
}
