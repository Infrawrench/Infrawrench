import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  withCursorPagination,
  type ApiFailure,
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

export type CloudinaryTransformation = ApiListItem<
  operations["listTransformations"],
  "transformations"
>;

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
 * 100 pages of 500 is 50,000 rows. Past that a list fails rather than come back
 * short, and a cursor that never changes stops here instead of looping forever.
 */
export const LIST_PAGES = 100;

/** Any non-2xx answer, carrying the status a list read has to tell apart. */
export class CloudinaryApiError extends Error {
  readonly status: number;
  constructor(failure: ApiFailure) {
    super(`Cloudinary API error ${failure.status} for ${failure.target}: ${failure.body}`);
    this.name = "CloudinaryApiError";
    this.status = failure.status;
  }
}

/** One page of a list: its rows, unchecked, and the cursor that follows it. */
export interface CloudinaryPage<T> {
  rows: readonly T[] | null | undefined;
  next: string | null | undefined;
}

/**
 * Every row of a cursor-paged list, or an error: a sync prunes what a list stops
 * returning, so a failed, malformed or too long list must never come back short.
 * Only a 404 on the first page can mean there are no rows, and only where asked.
 */
export async function readEveryPage<T>(
  where: { path: string; key: string; maxPages: number; notFoundIsEmpty?: boolean },
  readPage: (cursor: string | undefined) => Promise<CloudinaryPage<T>>,
): Promise<T[]> {
  const { path, key, maxPages, notFoundIsEmpty } = where;
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let answer: CloudinaryPage<T>;
    try {
      answer = await readPage(cursor);
    } catch (err) {
      if (
        notFoundIsEmpty &&
        page === 0 &&
        err instanceof CloudinaryApiError &&
        err.status === 404
      ) {
        return [];
      }
      throw err;
    }
    rows.push(...requireListPage(answer.rows, { vendor: "Cloudinary", path, key }));
    if (!answer.next) return rows;
    cursor = answer.next;
  }
  throw new ListTruncatedError({ vendor: "Cloudinary", path, items: rows.length, maxPages });
}

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
    httpError: (failure: ApiFailure) => new CloudinaryApiError(failure),
  };
  const api = createApiClient<paths>({ ...shared, encodeQuery: encodeURIComponent });
  return {
    api,
    pages: withCursorPagination(api, {
      cursorParam: "next_cursor",
      next: "next_cursor",
      maxPages: LIST_PAGES,
    }),
    /** Video Analytics takes a search expression, form-encoded (a space is `+`). */
    videoAnalytics: createApiClient<paths>(shared),
  };
}
