import {
  createApiClient,
  pathEncode,
  type ApiBody,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
  type NoSlashString,
  type ParamValue,
  withCursorPagination,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

/**
 * Xata control-plane API (`https://api.xata.tech`, OpenAPI at
 * `https://api.xata.tech/openapi.json`; verified 2026-10). This is the
 * current Xata, a Postgres platform with copy-on-write branches; the old
 * `*.xata.sh` workspace/database API is gone.
 *
 * Auth is `Authorization: Bearer <api key>`. Organization keys act as an
 * organization Admin limited by their scopes; user keys act with the
 * creating member's role.
 *
 * SQL does not go through the control plane: the gateway on the branch's own
 * host (`https://{branch}.{region}.xata.tech/sql`) takes the branch
 * connection string in a `Connection-String` header and rejects the API key.
 */
export const XATA_API = "https://api.xata.tech";

export interface XataContext {
  token: string;
  http?: HttpHostServices;
  caCert?: string;
}

export class XataApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "XataApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof XataApiError ? err.status : 0;
}

export function toError(status: number, label: string, raw: string): XataApiError {
  let message = "";
  try {
    const parsed: { message?: string; error?: string } = JSON.parse(raw);
    const m = parsed.message ?? parsed.error;
    if (typeof m === "string") message = m;
  } catch {
    message = raw.slice(0, 300);
  }
  if (status === 401) {
    return new XataApiError(
      401,
      "Xata API error 401: the API key was rejected. Create a new key in the Xata console under API Keys and update the account.",
    );
  }
  return new XataApiError(
    status,
    `Xata API error ${status} for ${label}${message ? `: ${message}` : ""}`,
  );
}

/** A 2xx that is not JSON has always reached callers as its text, so it travels as a JSON string. */
function textAsJson(status: number, text: string): string {
  if (status < 200 || status >= 300 || !text) return text;
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text);
  }
}

/**
 * The host's HTTP service, or `fetch` where there is no host, with `Accept` and
 * `Content-Type` ahead of the credential header. A CA only applies over the host.
 */
function transport(ctx: XataContext): HttpHostServices {
  const host = ctx.http;
  return {
    async request(req) {
      const contentType = req.headers["Content-Type"];
      const headers = {
        Accept: "application/json",
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...req.headers,
      };
      let status: number;
      let text: string;
      if (host) {
        const res = await host.request({ ...req, headers });
        status = res.status;
        text = res.body;
      } else {
        const res = await fetch(req.url, {
          method: req.method,
          headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
        });
        status = res.status;
        text = await res.text();
      }
      return { status, headers: {}, body: textAsJson(status, text) };
    },
  };
}

/** An empty value is left out rather than sent, so a branch with no region asks for none. */
function serializeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  return params.toString();
}

function createClient(ctx: XataContext, baseUrl: string, headers: Record<string, string>) {
  return createApiClient<paths>({
    vendor: "Xata",
    baseUrl,
    headers,
    http: transport(ctx),
    caCert: ctx.caCert,
    contentType: "with-body",
    serializeQuery,
    httpError: ({ status, path, body }) => toError(status, path, body),
  });
}

/** The control plane, with the API key. */
export function createXataApi(ctx: XataContext) {
  return createClient(ctx, XATA_API, { Authorization: `Bearer ${ctx.token}` });
}

export type XataApi = ReturnType<typeof createXataApi>;

/** 10,000 rows at the document's largest page of 100, for both paged lists. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** `billing/invoices` takes `cursor` and `limit`, with its next page in `pagination_metadata`. */
export function withInvoicePages(api: XataApi) {
  return withCursorPagination(api, {
    cursorParam: "cursor",
    sizeParam: "limit",
    pageSize: LIST_PAGE_SIZE,
    next: "pagination_metadata.next_cursor",
    hasMore: "pagination_metadata.has_more",
    maxPages: LIST_MAX_PAGES,
  });
}

/**
 * `invitations` takes a 0-based `first` and a `max`, and reports no total. Only an
 * empty page ends it, so a server answering short of `max` cannot cut the list off.
 */
export function withInvitationPages(api: XataApi) {
  return withCursorPagination(api, {
    cursorParam: "first",
    sizeParam: "max",
    pageSize: LIST_PAGE_SIZE,
    next: ({ cursor, items }) => Number(cursor ?? 0) + items.length,
    maxPages: LIST_MAX_PAGES,
  });
}

/** One branch's SQL gateway, which takes its connection string and rejects the API key. */
export function createGatewayApi(ctx: XataContext, host: string, connectionString: string) {
  return createClient(ctx, `https://${host}`, { "Connection-String": connectionString });
}

/** A missing part of a composite id has always gone out as the text `undefined`. */
export function enc(s: string | undefined): NoSlashString {
  return pathEncode(String(s));
}

export type OrgPath = `/organizations/${NoSlashString}`;
export type ProjectPath = `${OrgPath}/projects/${NoSlashString}`;
export type BranchPath = `${ProjectPath}/branches/${NoSlashString}`;

// ---- wire shapes ---------------------------------------------------------------

type Schemas = components["schemas"];

/** The listing has no `marketplace`; only `GET /organizations/{id}` does. */
export type XOrg = ApiListItem<operations["getOrganizationsList"], "organizations"> &
  Partial<Pick<Schemas["Organization"], "marketplace">>;
export type XProject = Schemas["Project"];
export type XBranchSummary = Schemas["BranchListMetadata"];
export type XBranchShort = Schemas["BranchShortMetadata"];
export type XBranch = Schemas["BranchMetadata"];
/** What a branch row needs, from whichever of the three branch answers there is. */
export type XBranchRow = Pick<XBranch, "id" | "name" | "createdAt" | "region" | "publicAccess"> &
  Partial<XBranch>;
export type XBranchPatch = ApiBody<operations["updateBranch"]>;
export type XProjectPatch = ApiBody<operations["updateProject"]>;
export type XProjectConfigPatch = Schemas["UpdateProjectConfiguration"];
export type XCredentials = Schemas["BranchCredentials"];
export type XBackup = Schemas["BackupMetadata"];
export type XApiKey = Schemas["APIKeyPreview"];
export type XInstanceType = ApiListItem<operations["listInstanceTypes"], "instanceTypes">;
export type XInvoice = Schemas["BillingInvoice"];
export type XUpcomingInvoice = ApiResponse<operations["getBillingUpcomingInvoice"]>;
export type XPgParameter = Schemas["PostgresConfigParameter"];
export type XMetricName = Schemas["BranchMetricName"];
export type XLogEntry = Schemas["LogEntry"];
