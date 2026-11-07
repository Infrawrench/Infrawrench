/**
 * Twilio REST transport.
 *
 * Twilio is several hosts behind one credential: the classic 2010-04-01 API
 * (`api.twilio.com`, accounts, numbers, usage, balance, triggers, TwiML apps,
 * keys), and the newer per-product APIs (`messaging.twilio.com/v1`,
 * `verify.twilio.com/v2`, `pricing.twilio.com/v1`). Everything authenticates
 * with HTTP Basic: either `API key SID : API key secret` or
 * `Account SID : Auth Token`. Writes are form-encoded, never JSON.
 *
 * Verified against Twilio's published OpenAPI documents
 * (`twilio/twilio-oai`, `spec/json/twilio_{api_v2010,messaging_v1,verify_v2,pricing_v1}.json`,
 * 2026-10).
 */
import {
  createApiClient,
  pathEncode,
  withLinkPagination,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { paths as MessagingPaths } from "./api-types.messaging.gen.js";
import type { paths as PricingPaths } from "./api-types.pricing.gen.js";
import type { paths as V2010Paths } from "./api-types.v2010.gen.js";
import type { paths as VerifyPaths } from "./api-types.verify.gen.js";

export const API_HOST = "https://api.twilio.com";
export const MESSAGING_HOST = "https://messaging.twilio.com";
export const VERIFY_HOST = "https://verify.twilio.com";
export const PRICING_HOST = "https://pricing.twilio.com";

/** Every host the plugin calls, for the bastion egress allowlist. */
export const TWILIO_HOSTNAMES = [
  "api.twilio.com",
  "messaging.twilio.com",
  "verify.twilio.com",
  "pricing.twilio.com",
];

export type TwilioAuthMode = "api-key" | "auth-token";

export interface TwilioContext {
  /** The main account (`AC…`) every 2010 path is scoped under. */
  accountSid: string;
  /** Basic-auth username: an API key SID (`SK…`) or the account SID. */
  username: string;
  /** Basic-auth password: the API key secret or the auth token. */
  password: string;
  authMode: TwilioAuthMode;
  caCert?: string;
  http?: HttpHostServices;
}

/** A Twilio error, carrying the HTTP status and Twilio's own error code. */
export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = "TwilioApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof TwilioApiError ? err.status : undefined;
}

/** 401/403: the credential cannot see this (wrong key type, or a subaccount the key can't reach). */
export function isAccessDenied(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

function basicAuth(ctx: TwilioContext): string {
  const raw = `${ctx.username}:${ctx.password}`;
  return `Basic ${btoa(raw)}`;
}

function describeError(status: number, body: string, path: string): TwilioApiError {
  let message = body;
  let code: number | undefined;
  try {
    const parsed: { message?: string; code?: number } = JSON.parse(body);
    if (parsed.message) message = parsed.message;
    if (typeof parsed.code === "number") code = parsed.code;
  } catch {
    // Non-JSON body: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the Account SID and the API key or auth token."
      : status === 403
        ? " The credential is not allowed to read this; a Standard API key cannot reach accounts, keys or subaccounts."
        : "";
  return new TwilioApiError(
    status,
    `Twilio API error ${status} for ${path}: ${message || "(empty)"}${code ? ` (code ${code})` : ""}.${hint}`,
    code,
  );
}

function clientFor<P>(ctx: TwilioContext, baseUrl: string) {
  return createApiClient<P>({
    vendor: "Twilio",
    baseUrl,
    // Per request: a secret `btoa` refuses fails the call, not building the client.
    headers: () => ({ Authorization: basicAuth(ctx), Accept: "application/json" }),
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    // Names a next link as Twilio wrote it, so an absolute one keeps its host.
    httpError: ({ status, body, path, link }) => {
      const named = link ?? path;
      return describeError(status, body, named.split("?")[0] ?? named);
    },
    ...(ctx.http ? { http: ctx.http } : {}),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
  });
}

/** Paging links are absolute on the v1/v2 APIs and host-relative on 2010. */
const onHost = (host: string) => (pathOrUrl: string) =>
  pathOrUrl.startsWith("http") ? pathOrUrl : `${host}${pathOrUrl}`;

/**
 * A list asks for 1000 a page and may run past an empty page. 50 pages is 50,000
 * rows, and a list longer than that fails rather than come back short.
 */
const LISTS = {
  sizeParam: "PageSize",
  pageSize: 1000,
  pagingFirst: true,
  maxPages: 50,
  continueOnEmptyPage: true,
  foreignLinks: "follow",
} as const;

/** The classic API. Lists page through a host-relative `next_page_uri`, null on the last page. */
export function v2010(ctx: TwilioContext) {
  const link = onHost(API_HOST);
  return withLinkPagination(clientFor<V2010Paths>(ctx, API_HOST), {
    ...LISTS,
    next: "next_page_uri",
    resolveLink: (uri) => (typeof uri === "string" ? link(uri) : null),
  });
}

/** Messaging services. Lists page through an absolute `meta.next_page_url`. */
export function messaging(ctx: TwilioContext) {
  return withLinkPagination(clientFor<MessagingPaths>(ctx, MESSAGING_HOST), {
    ...LISTS,
    next: "meta.next_page_url",
    resolveLink: onHost(MESSAGING_HOST),
  });
}

/** Verify services, paged like {@link messaging}. */
export function verify(ctx: TwilioContext) {
  return withLinkPagination(clientFor<VerifyPaths>(ctx, VERIFY_HOST), {
    ...LISTS,
    next: "meta.next_page_url",
    resolveLink: onHost(VERIFY_HOST),
  });
}

/** Number prices, which are read one country at a time. */
export function pricing(ctx: TwilioContext) {
  return clientFor<PricingPaths>(ctx, PRICING_HOST);
}

/** Path prefix for an account on the 2010 API. */
export function accountPath(accountSid: string): `/2010-04-01/Accounts/${NoSlashString}` {
  return `/2010-04-01/Accounts/${pathEncode(accountSid)}`;
}
