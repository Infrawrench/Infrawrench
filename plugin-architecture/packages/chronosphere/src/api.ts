import type { HttpHostServices, NoSlashString } from "@infrawrench/plugin-base";
import { createApiClient, jsonRestFetch, withCursorPagination } from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";

/**
 * Chronosphere (now Cortex XCOR) tenant APIs. Everything lives on the
 * tenant's own host, `https://<org>.chronosphere.io`:
 *
 * - Config API v1, `/api/v1/config/<plural>`: list with `page.max_size` and
 *   `page.token` answering `{ page: { next_token }, <plural_snake>: [...] }`;
 *   read `GET /<plural>/{slug}` answering `{ <singular>: {...} }`; create
 *   `POST` and update `PUT /{slug}` with `{ <singular>: {...} }`. Typed from
 *   the published Swagger document (`plugingen.json`).
 * - Prometheus API, `/data/metrics/api/v1/query` and `query_range`, which that
 *   document does not cover (`prom.ts`).
 *
 * Auth is the `API-Token` header (the docs also accept `Authorization:
 * Bearer`), with a service account or personal access token.
 */
type Schemas = components["schemas"];

export type Monitor = Schemas["configv1Monitor"];
export type NotificationPolicy = Schemas["configv1NotificationPolicy"];
export type Notifier = Schemas["configv1Notifier"];
export type Collection = Schemas["configv1Collection"];
export type Bucket = Schemas["configv1Bucket"];
export type Team = Schemas["configv1Team"];
export type Dashboard = Schemas["configv1Dashboard"];
export type Slo = Schemas["configv1SLO"];
export type RollupRule = Schemas["configv1RollupRule"];
export type DropRule = Schemas["configv1DropRule"];
export type RecordingRule = Schemas["configv1RecordingRule"];
export type MutingRule = Schemas["configv1MutingRule"];
export type ServiceAccount = Schemas["configv1ServiceAccount"];
export type Service = Schemas["configv1Service"];

/** The config object behind each slug-addressed resource type. */
export interface ConfigObjects {
  monitor: Monitor;
  "notification-policy": NotificationPolicy;
  notifier: Notifier;
  collection: Collection;
  bucket: Bucket;
  team: Team;
  dashboard: Dashboard;
  slo: Slo;
  "rollup-rule": RollupRule;
  "drop-rule": DropRule;
  "recording-rule": RecordingRule;
  "muting-rule": MutingRule;
  "service-account": ServiceAccount;
  service: Service;
}

export type ConfigTypeId = keyof ConfigObjects;

export interface ChronoContext {
  baseUrl: string;
  org: string;
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class ChronoApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChronoApiError";
    this.status = status;
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export function withQuery(url: string, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/** `acme`, `acme.chronosphere.io` or `https://acme.chronosphere.io/...` → `acme`. */
export function normalizeOrg(raw: string): string {
  let r = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  r = r.split("/")[0] ?? "";
  return r.replace(/\.chronosphere\.io$/, "");
}

/** Chronosphere errors are `{ code, message }` (gRPC gateway style). */
function friendly(status: number, message: string): string {
  const body = message.slice(message.indexOf(": ") + 2);
  try {
    const parsed: { message?: string } = JSON.parse(body);
    if (parsed.message) return `Chronosphere API error ${status}: ${parsed.message}`;
  } catch {
    // keep raw
  }
  return message;
}

/**
 * Give a failed call its status. This reads the message rather than the answer,
 * so a transport error or an unparsable body that names one is classified too.
 */
export async function guarded<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ChronoApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);
    if (status) throw new ChronoApiError(status, friendly(status, message));
    throw err;
  }
}

/** A call the Swagger document does not cover. */
export function chronoFetch<T>(
  ctx: ChronoContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  return guarded(
    jsonRestFetch<T>({
      vendor: "Chronosphere",
      url: withQuery(`${ctx.baseUrl}${path}`, query),
      errorPath: path,
      headers: { Accept: "application/json", "API-Token": ctx.token },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    }),
  );
}

export function statusOf(err: unknown): number {
  return err instanceof ChronoApiError ? err.status : 0;
}

// 50,000 rows at the size asked for, the most the host can prune.
const MAX_PAGES = 100;

/** The Config API. Its failures name the path without the query; see {@link guarded}. */
export function configApi(ctx: ChronoContext) {
  const api = createApiClient<paths>({
    vendor: "Chronosphere",
    baseUrl: ctx.baseUrl,
    headers: { Accept: "application/json", "API-Token": ctx.token },
    http: ctx.http,
    caCert: ctx.caCert,
    httpError: ({ status, path, body }) =>
      new Error(`Chronosphere API error ${status} for ${path}: ${body}`),
  });
  return withCursorPagination(api, {
    cursorParam: "page.token",
    sizeParam: "page.max_size",
    pageSize: 500,
    maxPages: MAX_PAGES,
    next: "page.next_token",
    // The document: "clients must never assume how many items will be returned", and
    // only an empty `next_token` means there are no more.
    continueOnEmptyPage: true,
    // The document is grpc-gateway output with no response field required, and proto3
    // JSON can leave out an empty repeated field.
    missingListIsEmpty: true,
  });
}

/** What one resource type's routes do, with a slug already encoded. */
export interface ConfigRoute<O> {
  /** Every object, walking `page.token`. `partial` is for a picker, never the inventory. */
  list(request?: { partial?: boolean }): Promise<O[]>;
  read(slug: NoSlashString): Promise<O>;
  /** Every type has one, because a write with an empty slug has always been a create. */
  create(body: O): Promise<O>;
  update(slug: NoSlashString, body: O): Promise<O>;
  /** Absent where the API has no such route. */
  delete?(slug: NoSlashString): Promise<object>;
}

export type ConfigRoutes = { [T in ConfigTypeId]: ConfigRoute<ConfigObjects[T]> };

export function isConfigType(typeId: string, routes: ConfigRoutes): typeId is ConfigTypeId {
  return Object.hasOwn(routes, typeId);
}

// The document has no PUT for service accounts and no POST or PUT for services,
// so those three stay hand-written.
interface ServiceAnswer {
  service?: Service;
}
interface ServiceAccountAnswer {
  service_account?: ServiceAccount;
}

/**
 * One entry per type, so every call is checked against the document. Each answer
 * falls back as the plugin always has: a read to an empty object, a write to what
 * was sent.
 */
export function configRoutes(ctx: ChronoContext): ConfigRoutes {
  const api = configApi(ctx);
  return {
    monitor: {
      list: (request) => api.getAll("/api/v1/config/monitors", "monitors", request),
      read: (slug) => api.get(`/api/v1/config/monitors/${slug}`).then((r) => r?.monitor ?? {}),
      create: (monitor) =>
        api
          .post("/api/v1/config/monitors", { body: { monitor } })
          .then((r) => r?.monitor ?? monitor),
      update: (slug, monitor) =>
        api
          .put(`/api/v1/config/monitors/${slug}`, { body: { monitor } })
          .then((r) => r?.monitor ?? monitor),
      delete: (slug) => api.delete(`/api/v1/config/monitors/${slug}`),
    },
    "notification-policy": {
      list: (request) =>
        api.getAll("/api/v1/config/notification-policies", "notification_policies", request),
      read: (slug) =>
        api
          .get(`/api/v1/config/notification-policies/${slug}`)
          .then((r) => r?.notification_policy ?? {}),
      create: (notification_policy) =>
        api
          .post("/api/v1/config/notification-policies", { body: { notification_policy } })
          .then((r) => r?.notification_policy ?? notification_policy),
      update: (slug, notification_policy) =>
        api
          .put(`/api/v1/config/notification-policies/${slug}`, { body: { notification_policy } })
          .then((r) => r?.notification_policy ?? notification_policy),
      delete: (slug) => api.delete(`/api/v1/config/notification-policies/${slug}`),
    },
    notifier: {
      list: (request) => api.getAll("/api/v1/config/notifiers", "notifiers", request),
      read: (slug) => api.get(`/api/v1/config/notifiers/${slug}`).then((r) => r?.notifier ?? {}),
      create: (notifier) =>
        api
          .post("/api/v1/config/notifiers", { body: { notifier } })
          .then((r) => r?.notifier ?? notifier),
      update: (slug, notifier) =>
        api
          .put(`/api/v1/config/notifiers/${slug}`, { body: { notifier } })
          .then((r) => r?.notifier ?? notifier),
      delete: (slug) => api.delete(`/api/v1/config/notifiers/${slug}`),
    },
    collection: {
      list: (request) => api.getAll("/api/v1/config/collections", "collections", request),
      read: (slug) =>
        api.get(`/api/v1/config/collections/${slug}`).then((r) => r?.collection ?? {}),
      create: (collection) =>
        api
          .post("/api/v1/config/collections", { body: { collection } })
          .then((r) => r?.collection ?? collection),
      update: (slug, collection) =>
        api
          .put(`/api/v1/config/collections/${slug}`, { body: { collection } })
          .then((r) => r?.collection ?? collection),
      delete: (slug) => api.delete(`/api/v1/config/collections/${slug}`),
    },
    bucket: {
      list: (request) => api.getAll("/api/v1/config/buckets", "buckets", request),
      read: (slug) => api.get(`/api/v1/config/buckets/${slug}`).then((r) => r?.bucket ?? {}),
      create: (bucket) =>
        api.post("/api/v1/config/buckets", { body: { bucket } }).then((r) => r?.bucket ?? bucket),
      update: (slug, bucket) =>
        api
          .put(`/api/v1/config/buckets/${slug}`, { body: { bucket } })
          .then((r) => r?.bucket ?? bucket),
      delete: (slug) => api.delete(`/api/v1/config/buckets/${slug}`),
    },
    team: {
      list: (request) => api.getAll("/api/v1/config/teams", "teams", request),
      read: (slug) => api.get(`/api/v1/config/teams/${slug}`).then((r) => r?.team ?? {}),
      create: (team) =>
        api.post("/api/v1/config/teams", { body: { team } }).then((r) => r?.team ?? team),
      update: (slug, team) =>
        api.put(`/api/v1/config/teams/${slug}`, { body: { team } }).then((r) => r?.team ?? team),
      delete: (slug) => api.delete(`/api/v1/config/teams/${slug}`),
    },
    dashboard: {
      list: (request) => api.getAll("/api/v1/config/dashboards", "dashboards", request),
      read: (slug) => api.get(`/api/v1/config/dashboards/${slug}`).then((r) => r?.dashboard ?? {}),
      create: (dashboard) =>
        api
          .post("/api/v1/config/dashboards", { body: { dashboard } })
          .then((r) => r?.dashboard ?? dashboard),
      update: (slug, dashboard) =>
        api
          .put(`/api/v1/config/dashboards/${slug}`, { body: { dashboard } })
          .then((r) => r?.dashboard ?? dashboard),
      delete: (slug) => api.delete(`/api/v1/config/dashboards/${slug}`),
    },
    slo: {
      list: (request) => api.getAll("/api/v1/config/slos", "slos", request),
      read: (slug) => api.get(`/api/v1/config/slos/${slug}`).then((r) => r?.slo ?? {}),
      create: (slo) =>
        api.post("/api/v1/config/slos", { body: { slo } }).then((r) => r?.slo ?? slo),
      update: (slug, slo) =>
        api.put(`/api/v1/config/slos/${slug}`, { body: { slo } }).then((r) => r?.slo ?? slo),
      delete: (slug) => api.delete(`/api/v1/config/slos/${slug}`),
    },
    "rollup-rule": {
      list: (request) => api.getAll("/api/v1/config/rollup-rules", "rollup_rules", request),
      read: (slug) =>
        api.get(`/api/v1/config/rollup-rules/${slug}`).then((r) => r?.rollup_rule ?? {}),
      create: (rollup_rule) =>
        api
          .post("/api/v1/config/rollup-rules", { body: { rollup_rule } })
          .then((r) => r?.rollup_rule ?? rollup_rule),
      update: (slug, rollup_rule) =>
        api
          .put(`/api/v1/config/rollup-rules/${slug}`, { body: { rollup_rule } })
          .then((r) => r?.rollup_rule ?? rollup_rule),
      delete: (slug) => api.delete(`/api/v1/config/rollup-rules/${slug}`),
    },
    "drop-rule": {
      list: (request) => api.getAll("/api/v1/config/drop-rules", "drop_rules", request),
      read: (slug) => api.get(`/api/v1/config/drop-rules/${slug}`).then((r) => r?.drop_rule ?? {}),
      create: (drop_rule) =>
        api
          .post("/api/v1/config/drop-rules", { body: { drop_rule } })
          .then((r) => r?.drop_rule ?? drop_rule),
      update: (slug, drop_rule) =>
        api
          .put(`/api/v1/config/drop-rules/${slug}`, { body: { drop_rule } })
          .then((r) => r?.drop_rule ?? drop_rule),
      delete: (slug) => api.delete(`/api/v1/config/drop-rules/${slug}`),
    },
    "recording-rule": {
      list: (request) => api.getAll("/api/v1/config/recording-rules", "recording_rules", request),
      read: (slug) =>
        api.get(`/api/v1/config/recording-rules/${slug}`).then((r) => r?.recording_rule ?? {}),
      create: (recording_rule) =>
        api
          .post("/api/v1/config/recording-rules", { body: { recording_rule } })
          .then((r) => r?.recording_rule ?? recording_rule),
      update: (slug, recording_rule) =>
        api
          .put(`/api/v1/config/recording-rules/${slug}`, { body: { recording_rule } })
          .then((r) => r?.recording_rule ?? recording_rule),
      delete: (slug) => api.delete(`/api/v1/config/recording-rules/${slug}`),
    },
    "muting-rule": {
      list: (request) => api.getAll("/api/v1/config/muting-rules", "muting_rules", request),
      read: (slug) =>
        api.get(`/api/v1/config/muting-rules/${slug}`).then((r) => r?.muting_rule ?? {}),
      create: (muting_rule) =>
        api
          .post("/api/v1/config/muting-rules", { body: { muting_rule } })
          .then((r) => r?.muting_rule ?? muting_rule),
      update: (slug, muting_rule) =>
        api
          .put(`/api/v1/config/muting-rules/${slug}`, { body: { muting_rule } })
          .then((r) => r?.muting_rule ?? muting_rule),
      delete: (slug) => api.delete(`/api/v1/config/muting-rules/${slug}`),
    },
    "service-account": {
      list: (request) => api.getAll("/api/v1/config/service-accounts", "service_accounts", request),
      read: (slug) =>
        api.get(`/api/v1/config/service-accounts/${slug}`).then((r) => r?.service_account ?? {}),
      create: (service_account) =>
        api
          .post("/api/v1/config/service-accounts", { body: { service_account } })
          .then((r) => r?.service_account ?? service_account),
      update: (slug, service_account) =>
        chronoFetch<ServiceAccountAnswer>(ctx, `/api/v1/config/service-accounts/${slug}`, {
          method: "PUT",
          body: JSON.stringify({ service_account }),
        }).then((r) => r?.service_account ?? service_account),
      delete: (slug) => api.delete(`/api/v1/config/service-accounts/${slug}`),
    },
    service: {
      list: (request) => api.getAll("/api/v1/config/services", "services", request),
      read: (slug) => api.get(`/api/v1/config/services/${slug}`).then((r) => r?.service ?? {}),
      create: (service) =>
        chronoFetch<ServiceAnswer>(ctx, "/api/v1/config/services", {
          method: "POST",
          body: JSON.stringify({ service }),
        }).then((r) => r?.service ?? service),
      update: (slug, service) =>
        chronoFetch<ServiceAnswer>(ctx, `/api/v1/config/services/${slug}`, {
          method: "PUT",
          body: JSON.stringify({ service }),
        }).then((r) => r?.service ?? service),
    },
  };
}
