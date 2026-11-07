import {
  createApiClient,
  withCursorPagination,
  type ApiFailure,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

export const BASE_URL = "https://api.workos.com";

/** WorkOS list page size: the API caps `limit` at 100. */
export const PAGE_SIZE = 100;

/** 50,000 rows, the most a resource sync can prune. A list longer than this throws. */
export const MAX_LIST_PAGES = 500;

/**
 * For a picker or a label on a detail view, over lists that can run to every user in an
 * environment: part of the list is fine, and nothing is stored or acted on as complete.
 */
export const PICKER_READ = { maxPages: 20, partial: true } as const;

/** Which part of a list a read needs. */
export interface ListRead {
  maxPages?: number;
  partial?: boolean;
}

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

/** A failed call with its status, for the callers that branch on one. */
export class WorkosApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkosApiError";
  }
}

/** The key cannot see this object, or it has gone since the list that named it. */
export function isOutOfReach(err: unknown): boolean {
  return err instanceof WorkosApiError && (err.status === 403 || err.status === 404);
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
  const common = {
    vendor: "WorkOS",
    baseUrl: BASE_URL,
    headers,
    caCert,
    httpError: ({ status, target, body }: ApiFailure) =>
      new WorkosApiError(status, `WorkOS API error ${status} for ${target}: ${body}`),
  };
  return {
    api: withCursorPagination(createApiClient<paths>({ ...common, http }), {
      cursorParam: "after",
      sizeParam: "limit",
      pageSize: PAGE_SIZE,
      maxPages: MAX_LIST_PAGES,
      next: "list_metadata.after",
    }),
    bodiless: createApiClient<paths>({
      ...common,
      contentType: "with-body",
      http: ignoringSuccessBody(http, caCert),
    }),
  };
}
