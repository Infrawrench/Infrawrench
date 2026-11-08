/**
 * The OpenAPI document: every operation and component an HttpApi domain
 * declares (`http/openapi.ts`), on top of a base of plain data
 * (`./base-document.ts`), the plugin registry's enums (`./dynamic.ts`) and the
 * event subscription webhooks (`./event-webhooks.ts`). The shared
 * post-processing then derives operation ids, appends each gate's permission
 * note and marks internal routes (`./public-spec.ts`).
 */
import { injectSdkCodeSamples } from "../../../scripts/sdk/code-samples";
import { buildOpenApiFragment, mergeOpenApiFragment } from "../../http/openapi";
import { DOMAINS } from "../../http/domains";
import {
  API_INFO_DESCRIPTION,
  API_INFO_TITLE,
  API_LICENSE,
  DEFAULT_SECURITY,
  SECURITY_SCHEMES,
  TAGS,
  type OpenApiTag,
  type SecurityScheme,
} from "./base-document";
import { buildDynamicEnums } from "./dynamic";
import { buildEventWebhooks } from "./event-webhooks";
import { injectInternalMarkers, toPublicDocument } from "./public-spec";
import { API_VERSION } from "./version";

type JsonObject = Record<string, unknown>;

/** The document this module builds, as far as its consumers read it. */
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description: string;
    license: { name: string; url: string };
  };
  servers: Array<{ url: string; description?: string }>;
  security: Array<Record<string, readonly string[]>>;
  tags: OpenApiTag[];
  components: {
    securitySchemes: Record<string, SecurityScheme>;
    schemas: Record<string, unknown>;
  };
  paths: Record<string, Record<string, JsonObject>>;
  webhooks: Record<string, Record<string, unknown>>;
}

interface BuildOptions {
  /** Server URL(s) to advertise in the spec. */
  servers?: Array<{ url: string; description?: string }>;
  /** Override the spec version (defaults to `API_VERSION`). */
  version?: string;
}

/**
 * Servers to advertise when the caller doesn't specify. A deployment knows its
 * own origin (`APP_URL` / `PUBLIC_BASE_URL`, set in prod), so serve that alone,
 * otherwise Scalar picks the first entry and every "try it" request and code
 * snippet on the production docs points at `localhost:3000`.
 */
function defaultServers(): Array<{ url: string; description?: string }> {
  const explicit = process.env["PUBLIC_BASE_URL"] ?? process.env["APP_URL"];
  if (explicit) return [{ url: explicit.replace(/\/$/, ""), description: "This deployment" }];
  return [{ url: "http://localhost:3000", description: "Local dev" }];
}

export async function buildOpenApiDocument(opts: BuildOptions = {}): Promise<OpenApiDocument> {
  const events = buildEventWebhooks();
  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: API_INFO_TITLE,
      version: opts.version ?? API_VERSION,
      description: API_INFO_DESCRIPTION,
      license: { ...API_LICENSE },
    },
    servers: opts.servers ?? defaultServers(),
    security: DEFAULT_SECURITY.map((requirement) => ({ ...requirement })),
    tags: TAGS.map((tag) => ({ ...tag })),
    components: {
      securitySchemes: { ...SECURITY_SCHEMES },
      // HttpApi domains refer to the registry enums by `$ref`
      // (`http/schemas/plugin-registry.ts`), so they are components here.
      schemas: { ...(await buildDynamicEnums()), ...events.schemas },
    },
    paths: {},
    webhooks: events.webhooks,
  };

  mergeOpenApiFragment(doc, buildOpenApiFragment(DOMAINS));

  injectOperationIds(doc);
  injectRequiredPermissions(doc);
  injectInternalMarkers(doc);
  return doc;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

/**
 * Auto-derive `operationId` from method + path so generated SDKs have stable
 * function names. e.g. `POST /api/org/{orgId}/sql/query` → `postOrgSqlQuery`.
 */
function injectOperationIds(doc: OpenApiDocument) {
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op["operationId"] === "string") continue;
      op["operationId"] = deriveOperationId(method, path);
    }
  }
}

/**
 * Append the permission note to the description of every operation with a
 * gate. The gate itself, `x-required-permission`, is set from the endpoint's
 * `RequiredPermission` (or `DocumentedPermission`) annotation by the fragment
 * builder, so the note always states the gate `OrgAuth` enforces.
 */
function injectRequiredPermissions(doc: OpenApiDocument) {
  for (const item of Object.values(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      const required = op?.["x-required-permission"];
      if (!op || typeof required !== "string") continue;
      const existingDesc = typeof op["description"] === "string" ? op["description"] : "";
      const note = `_Requires permission: \`${required}\`._`;
      op["description"] = existingDesc ? `${existingDesc}\n\n${note}` : note;
    }
  }
}

function deriveOperationId(method: string, path: string): string {
  const segments = path
    .replace(/^\/api\//, "")
    .replace(/^v1\//, "v1-")
    .split("/")
    .filter(Boolean)
    .map((seg) => seg.replace(/[{}]/g, ""))
    .map((seg, i) => {
      const camel = seg.replace(/[-_](.)/g, (_, c: string) => c.toUpperCase());
      return i === 0 ? camel : camel.charAt(0).toUpperCase() + camel.slice(1);
    });
  return method + segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

/** Cached documents; safe to call repeatedly from request handlers. */
let _cached: OpenApiDocument | null = null;
let _cachedPublic: OpenApiDocument | null = null;

/** The full spec, internal routes included. Used by `generate:openapi`. */
async function getOpenApiDocument(opts: BuildOptions = {}): Promise<OpenApiDocument> {
  if (_cached) return _cached;
  _cached = await buildOpenApiDocument(opts);
  return _cached;
}

/**
 * The spec we publish: the same document with `x-internal` operations, the
 * `sessionCookie` scheme, and the tags/schemas only they used removed. This is
 * what `/openapi.json` serves and what `/docs` renders. See `./public-spec.ts`.
 *
 * Every published operation additionally carries `x-codeSamples` showing the
 * call as each generated SDK spells it, so the `/docs` client picker offers
 * the real clients instead of only generic HTTP snippets. The samples are
 * derived from the same IR the SDK generator consumes (which is why this
 * reaches into `scripts/sdk`); they exist only on the served document: the
 * committed `openapi.json` stays snippet-free so its diffs show surface
 * changes.
 */
export async function getPublicOpenApiDocument(opts: BuildOptions = {}): Promise<OpenApiDocument> {
  if (_cachedPublic) return _cachedPublic;
  const doc = toPublicDocument(await getOpenApiDocument(opts));
  injectSdkCodeSamples(doc);
  _cachedPublic = doc;
  return _cachedPublic;
}
