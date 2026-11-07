import {
  createApiClient,
  pathEncode,
  restRequest,
  withCursorPagination,
  type ApiResponse,
  type CursorApiClient,
  type HttpHostServices,
  type NextPage,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/**
 * Pulumi Cloud REST API (https://www.pulumi.com/docs/reference/cloud-rest-api/,
 * OpenAPI spec at https://api.pulumi.com/api/openapi/pulumi-spec.json,
 * verified 2026-10).
 *
 * - `Authorization: token <access token>` (the literal word `token`, not
 *   `Bearer`) and `Accept: application/vnd.pulumi+8` on every call.
 * - Managed Pulumi Cloud is `https://api.pulumi.com`; self-hosted installs
 *   have their own API URL.
 * - Lists page with `continuationToken` (stacks, environments, tokens,
 *   members) or `page`/`pageSize` (updates, deployments).
 * - ESC environment definitions are `application/x-yaml`, not JSON.
 */
export const DEFAULT_API_URL = "https://api.pulumi.com";

export interface PuContext {
  token: string;
  apiUrl: string;
  http?: HttpHostServices;
  caCert?: string;
}

export class PulumiApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PulumiApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof PulumiApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/** `https://api.example.com/` → `https://api.example.com`; refuses anything but https. */
export function normaliseApiUrl(raw: string | undefined): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return DEFAULT_API_URL;
  let u: URL;
  try {
    u = new URL(v.includes("://") ? v : `https://${v}`);
  } catch {
    throw new Error(`Pulumi Cloud plugin: "${raw}" is not a URL`);
  }
  if (u.protocol !== "https:") throw new Error("Pulumi Cloud plugin: the API URL must use https");
  return `https://${u.host}`;
}

/** The console URL that matches an API URL (`api.pulumi.com` → `app.pulumi.com`). */
export function consoleUrl(apiUrl: string): string {
  const host = new URL(apiUrl).host;
  return host.startsWith("api.") ? `https://app.${host.slice(4)}` : `https://${host}`;
}

export function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    )
      return parsed.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 500);
}

const VENDOR = "Pulumi Cloud";
const MAX_LIST_PAGES = 20;

function pulumiError(status: number, path: string, body: string): PulumiApiError {
  return new PulumiApiError(
    status,
    `Pulumi Cloud API error ${status} for ${path}: ${errorDetail(body)}`,
  );
}

/** A cursor that is only a cursor if it is non-empty text, whatever the list's field holds. */
const stringField =
  (key: string): NextPage =>
  ({ body }) => {
    const value: unknown =
      typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;
    return typeof value === "string" ? value : undefined;
  };

export type StackPath = `/api/stacks/${NoSlashString}/${NoSlashString}/${NoSlashString}`;
export type EnvironmentPath =
  `/api/esc/environments/${NoSlashString}/${NoSlashString}/${NoSlashString}`;

/** Both list dialects read their next page with {@link stringField}, so they type alike. */
type Lists = CursorApiClient<
  paths,
  { cursorParam: "continuationToken"; sizeParam: never; next: NextPage; hasMore: never }
>;

export type PulumiApi = Lists & {
  environmentPages: Lists;
  patchEnvironmentYaml: (
    path: EnvironmentPath,
    yaml: string,
  ) => Promise<ApiResponse<operations["UpdateEnvironment_esc_environments"]>>;
};

export function createPulumiApi(ctx: PuContext): PulumiApi {
  const { apiUrl, http, caCert } = ctx;
  const headers = {
    Accept: "application/vnd.pulumi+8",
    Authorization: `token ${ctx.token}`,
  };
  const client = createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: apiUrl,
    headers,
    http,
    caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError: ({ status, path, body }) => pulumiError(status, path, body),
  });
  const lists = {
    cursorParam: "continuationToken",
    maxPages: MAX_LIST_PAGES,
    continueOnEmptyPage: true,
    emptyBodyEndsList: true,
  } as const;
  return {
    /** Lists hand back their next page in `continuationToken`. */
    ...withCursorPagination(client, { ...lists, next: stringField("continuationToken") }),
    /** ESC environments take the same parameter and answer in `nextToken`. */
    environmentPages: withCursorPagination(client, { ...lists, next: stringField("nextToken") }),
    /** The document's only body for this is YAML, which the typed client does not send. */
    patchEnvironmentYaml: async (path: EnvironmentPath, yaml: string) =>
      (
        await restRequest<ApiResponse<operations["UpdateEnvironment_esc_environments"]>>({
          vendor: VENDOR,
          url: `${apiUrl}${path}`,
          errorPath: path,
          headers,
          init: { method: "PATCH", body: yaml },
          ...(http ? { http } : {}),
          ...(caCert ? { caCert } : {}),
          contentType: "with-body",
          bodyType: "application/x-yaml",
          emptyBodyIsUndefined: true,
          httpError: ({ status, body }) => pulumiError(status, path, body),
        })
      ).body,
  };
}

export const enc = encodeURIComponent;

/** `org/project/stack` path segment. */
export function stackPath(org: string, project: string, stack: string): StackPath {
  return `/api/stacks/${pathEncode(org)}/${pathEncode(project)}/${pathEncode(stack)}`;
}

export function environmentPath(org: string, project: string, name: string): EnvironmentPath {
  return `/api/esc/environments/${pathEncode(org)}/${pathEncode(project)}/${pathEncode(name)}`;
}

/** The marker Pulumi puts on an encrypted secret value in state and outputs. */
export const SECRET_SIG = "4dabf18193072939515e22adb298388d";

export function isSecretValue(v: unknown): v is { ciphertext?: string; plaintext?: string } {
  return Boolean(
    v &&
    typeof v === "object" &&
    SECRET_SIG in v &&
    v[SECRET_SIG] === "1b47061264138c4ac30d75fd1eb44270",
  );
}
