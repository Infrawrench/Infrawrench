/**
 * Twilio SendGrid v3 transport.
 *
 * `https://api.sendgrid.com` for global accounts and subusers,
 * `https://api.eu.sendgrid.com` for EU regional subusers. Auth is
 * `Authorization: Bearer <API key>`; the optional `on-behalf-of: <username>`
 * header lets a parent account's key act as one of its subusers. Errors are
 * `{ errors: [{ message, field }] }`.
 *
 * Typed from Twilio's published OpenAPI documents (`twilio/sendgrid-oai`,
 * `spec/json/tsg_*_v3.json`), which split the API into one file per product.
 * Every one has the same hosts and auth, so they make one client.
 */
import {
  createApiClient,
  withCursorPagination,
  type ApiClient,
  type ApiListItem,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as AlertPaths } from "./api-types.alerts.gen.js";
import type { paths as ApiKeyPaths } from "./api-types.api-keys.gen.js";
import type { paths as DomainPaths } from "./api-types.domain-authentication.gen.js";
import type { paths as IpWarmupPaths } from "./api-types.ip-warmup.gen.js";
import type { paths as IpPaths } from "./api-types.ips.gen.js";
import type { paths as LinkPaths } from "./api-types.link-branding.gen.js";
import type { paths as ReverseDnsPaths } from "./api-types.reverse-dns.gen.js";
import type { paths as ScopePaths } from "./api-types.scopes.gen.js";
import type { paths as StatPaths } from "./api-types.stats.gen.js";
import type { paths as SubuserPaths } from "./api-types.subusers.gen.js";
import type { paths as SuppressionPaths } from "./api-types.suppressions.gen.js";
import type {
  operations as TemplateOperations,
  paths as TemplatePaths,
} from "./api-types.templates.gen.js";
import type { paths as UserPaths } from "./api-types.user.gen.js";
import type { paths as VerifiedSenderPaths } from "./api-types.verified-senders.gen.js";
import type { paths as WebhookPaths } from "./api-types.webhooks.gen.js";

export const API_HOSTS = {
  global: "https://api.sendgrid.com",
  eu: "https://api.eu.sendgrid.com",
} as const;

export type SendGridRegion = keyof typeof API_HOSTS;

export const SENDGRID_HOSTNAMES = ["api.sendgrid.com", "api.eu.sendgrid.com"];

export interface SendGridContext {
  apiKey: string;
  region: SendGridRegion;
  /** Subuser username sent as `on-behalf-of`, or empty for the key's own account. */
  onBehalfOf: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class SendGridApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SendGridApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof SendGridApiError ? err.status : undefined;
}

/** 401/403: the key lacks the scope (or the plan lacks the feature). */
export function isAccessDenied(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

interface ErrorBody {
  errors?: Array<{ message?: string; field?: string | null }>;
}

function describeError(status: number, body: string, path: string): SendGridApiError {
  let message = body;
  try {
    const parsed: ErrorBody = JSON.parse(body);
    const msgs = (parsed.errors ?? [])
      .map((e) => (e.field ? `${e.field}: ${e.message ?? ""}` : (e.message ?? "")))
      .filter(Boolean);
    if (msgs.length > 0) message = msgs.join("; ");
  } catch {
    // Non-JSON body: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the API key and that the region matches the account."
      : status === 403
        ? " The API key is missing a scope this needs, or the plan does not include the feature."
        : status === 429
          ? " SendGrid is rate limiting this key; try again shortly."
          : "";
  return new SendGridApiError(
    status,
    `SendGrid API error ${status} for ${path}: ${message || "(empty)"}.${hint}`,
  );
}

/** An empty value is left out, which is what a resource id with nothing in it comes to. */
function writeQuery(query: Record<string, ParamValue>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") qs.append(k, String(v));
  }
  return qs.toString();
}

type SendGridPaths = AlertPaths &
  ApiKeyPaths &
  DomainPaths &
  IpWarmupPaths &
  IpPaths &
  LinkPaths &
  ReverseDnsPaths &
  ScopePaths &
  StatPaths &
  SubuserPaths &
  SuppressionPaths &
  TemplatePaths &
  UserPaths &
  VerifiedSenderPaths &
  WebhookPaths;

const PAGE_SIZE = 100;

/** `limit`/`offset` lists that answer a bare array: 50 pages, so 5000 items at most. */
function withOffsetLists(client: ApiClient<SendGridPaths>) {
  return withCursorPagination(client, {
    cursorParam: "offset",
    firstCursor: 0,
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    maxPages: 50,
    // By the page size, not by what came back: a page may be longer than was asked for.
    next: ({ cursor }) => Number(cursor) + PAGE_SIZE,
    stopOnShortPage: true,
    emptyBodyEndsList: true,
  });
}

function createClient(ctx: SendGridContext, onBehalfOf: string) {
  return withOffsetLists(
    createApiClient<SendGridPaths>({
      vendor: "SendGrid",
      baseUrl: API_HOSTS[ctx.region],
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        Accept: "application/json",
        ...(onBehalfOf ? { "on-behalf-of": onBehalfOf } : {}),
      },
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      serializeQuery: writeQuery,
      httpError: ({ status, body, path }) => describeError(status, body, path),
      http: ctx.http,
      caCert: ctx.caCert,
    }),
  );
}

export type SendGridApi = ReturnType<typeof createClient>;

export interface SendGridApis {
  /** Acts as the connection's subuser, when it has one. */
  api: SendGridApi;
  /** Never sends `on-behalf-of`, for parent-only endpoints such as `/v3/subusers`. */
  parent: SendGridApi;
}

export function createSendGridApis(ctx: SendGridContext): SendGridApis {
  return { api: createClient(ctx, ctx.onBehalfOf), parent: createClient(ctx, "") };
}

/**
 * Walk `/v3/templates`, which pages by `page_token` taken from the absolute
 * `_metadata.next` URL (max `page_size` 200).
 */
export async function listTemplates(
  api: SendGridApi,
  maxPages = 25,
): Promise<ApiListItem<TemplateOperations["ListTemplate"], "result">[]> {
  const out: ApiListItem<TemplateOperations["ListTemplate"], "result">[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await api.get("/v3/templates", {
      query: {
        generations: "legacy,dynamic",
        page_size: 200,
        ...(token !== undefined ? { page_token: token } : {}),
      },
    });
    out.push(...(res?.result ?? []));
    const next = res?._metadata?.next;
    if (!next) break;
    let nextToken: string | null = null;
    try {
      nextToken = new URL(next).searchParams.get("page_token");
    } catch {
      nextToken = null;
    }
    if (!nextToken || nextToken === token) break;
    token = nextToken;
  }
  return out;
}
