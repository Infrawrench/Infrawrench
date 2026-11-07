import {
  createApiClient,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

export const BASE_URL = "https://api.workos.com";

/** WorkOS list page size: the API caps `limit` at 100. */
export const PAGE_SIZE = 100;

/** Hard cap on cursor-following so a huge environment can't hang a sync. */
export const MAX_LIST_PAGES = 20;

/** An operation's response, by its `operationId`. */
type WosResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type WosOrganization = ApiListItem<operations["OrganizationsController_list"], "data">;
export type WosOrganizationDomain =
  | NonNullable<WosOrganization["domains"]>[number]
  | WosResponse<"OrganizationDomainsController_get">;
export type WosUser =
  | ApiListItem<operations["UserlandUsersController_list[0]"], "data">
  | WosResponse<"UserlandUsersController_get[0]">;
export type WosMembership = ApiListItem<
  operations["UserlandUserOrganizationMembershipsController_list"],
  "data"
>;
export type WosMembershipStatus = NonNullable<
  NonNullable<
    operations["UserlandUserOrganizationMembershipsController_list"]["parameters"]["query"]
  >["statuses"]
>[number];
export type WosMemberRow = ApiListItem<
  operations["GroupMembershipsController_listMembers"],
  "data"
>;
export type WosInvitation = ApiListItem<operations["UserlandUserInvitesController_list"], "data">;
export type WosConnection = ApiListItem<operations["ConnectionsController_list"], "data">;
export type WosDirectory = ApiListItem<operations["DirectoriesController_list"], "data">;
export type WosDirectoryUser = ApiListItem<operations["DirectoryUsersController_list"], "data">;
export type WosDirectoryGroup = ApiListItem<operations["DirectoryGroupsController_list"], "data">;
export type WosRole = ApiListItem<operations["AuthorizationRolesController_list"], "data">;
export type WosPermission = ApiListItem<
  operations["AuthorizationPermissionsController_list"],
  "data"
>;
export type WosApiKey = ApiListItem<operations["OrganizationApiKeysController_list"], "data">;
export type WosFeatureFlag = ApiListItem<operations["FeatureFlagsController_list"], "data">;
export type WosGroup = ApiListItem<operations["GroupsController_list"], "data">;
export type WosSession = ApiListItem<operations["UserlandUserSessionsController_list"], "data">;
export type WosEvent = ApiListItem<operations["EventsController_list"], "data">;
export type WosWebhookEndpoint = ApiListItem<operations["WebhookEndpointsController_list"], "data">;

/** The paging parameters of one request of a list. */
interface Paging {
  limit: number;
  after?: string;
}

/** Standard WorkOS list envelope: `{object: "list", data, list_metadata}`. */
interface Page<T> {
  data?: T[];
  list_metadata?: { after?: string | null };
}

/**
 * Follow the `list_metadata.after` cursor until the API stops returning one
 * (bounded by MAX_LIST_PAGES). `getPage` asks for one page of `path`, so its route,
 * its other parameters and its response are all checked at the call. It stays a loop
 * rather than `withCursorPagination` because this has always read a cursor that is
 * not a string as the end of the list, and warned about a cursor left on an empty page.
 */
export async function paginate<const Path extends string, T>(
  path: Path,
  getPage: (path: Path, paging: Paging) => Promise<Page<T>>,
): Promise<T[]> {
  const out: T[] = [];
  let after = "";

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const body = await getPage(path, after ? { limit: PAGE_SIZE, after } : { limit: PAGE_SIZE });
    const items = body.data ?? [];
    out.push(...items);
    after = cursorOf(body);
    if (!after || items.length === 0) break;
  }

  // A cursor surviving the page cap means the listing is a prefix, not the
  // whole set. There is no host warning channel for list results, so the
  // console is the one place this can surface (visible in poller logs).
  if (after) {
    console.warn(
      `WorkOS plugin: list ${path} truncated at ${MAX_LIST_PAGES} pages (${out.length} items); a continuation cursor remains`,
    );
  }

  return out;
}

/** The next cursor, or `""` at the end of a list. Responses are not validated. */
export function cursorOf(page: { list_metadata?: { after?: string | null } }): string {
  const after = page.list_metadata?.after;
  return typeof after === "string" ? after : "";
}

/**
 * The transport for requests whose success response carries nothing we read: WorkOS
 * DELETEs answer 200/202/204 with an empty body, or with one that need not be JSON,
 * so a 2xx body is dropped before the client can try to parse it.
 */
function ignoringSuccessBody(http: HttpHostServices | undefined, caCert: string): HttpHostServices {
  return {
    request: async (request) => {
      if (http) {
        const answer = await http.request(request);
        return answer.status >= 200 && answer.status < 300 ? { ...answer, body: "" } : answer;
      }
      // Only the host HTTP service can install a custom trust anchor: silently
      // falling back to global fetch would issue this request under a different
      // trust store than the host does.
      if (caCert) {
        throw new Error(
          `WorkOS plugin: cannot apply the configured CA certificate for ${request.url.slice(BASE_URL.length)} without the host HTTP service`,
        );
      }
      const res = await fetch(request.url, { method: request.method, headers: request.headers });
      return { status: res.status, headers: {}, body: res.ok ? "" : await res.text() };
    },
  };
}

/**
 * Auth is `Authorization: Bearer sk_…` against https://api.workos.com. `api` is for
 * calls that read their answer; `bodiless` is for the ones that only care it worked,
 * and sends no `Content-Type`.
 */
export function createWorkosApi(options: {
  apiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}) {
  const { apiKey, caCert, http } = options;
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const common = { vendor: "WorkOS", baseUrl: BASE_URL, headers, caCert };
  return {
    api: createApiClient<paths>({ ...common, http }),
    bodiless: createApiClient<paths>({
      ...common,
      contentType: "with-body",
      http: ignoringSuccessBody(http, caCert),
    }),
  };
}
